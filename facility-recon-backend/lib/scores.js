const winston = require('winston');
const async = require('async');
const request = require('request');
const URI = require('urijs');
const levenshtein = require('fast-levenshtein');
const geodist = require('geodist');
const _ = require('underscore');
// const save = require('child_process').fork('save.js')
const config = require('./config');
const mcsd = require('./mcsd')();

module.exports = function () {
  return {
    getJurisdictionScore(mcsdMOH, mcsdDATIM, mcsdMapped, mcsdDatimAll, mcsdMohAll, mohDB, datimDB, mohTopId, datimTopId, recoLevel, totalLevels, callback) {
      const scoreResults = [];
      const mapped = [];
      const matchBrokenCode = config.getConf('mapping:matchBrokenCode');
      const maxSuggestions = config.getConf('matchResults:maxSuggestions');
      if (mcsdDATIM.total == 0) {
        winston.error('No DATIM data found for this orgunit');
        return callback();
      }
      if (mcsdMOH.total == 0) {
        winston.error('No MOH data found');
        return callback();
      }
      let count = 0;
      var ignore = []
      var datimParentNames = {}
      var datimMappedParentNames = {}
      for ( entry of mcsdDATIM.entry ) {
        if (entry.resource.hasOwnProperty('partOf')) {
          datimParentNames[entry.resource.id] = [];
          datimMappedParentNames[entry.resource.id] = [];
          var entityParent = entry.resource.partOf.reference;
          mcsd.getLocationParentsFromData(entityParent, mcsdDatimAll, 'all', (parents) => {
            // lets make sure that we use the mapped parent for comparing against MOH
            for( parent of parents ) {
              this.matchStatus(mcsdMapped, parent.id, (mapped) => {
                if (mapped) {
                  const mappedPar = mapped.resource.identifier.find((identifier) => {
                    if (identifier.system == 'http://geoalign.datim.org/MOH') {
                      const mohParId = identifier.value.split('/').pop();
                      var mohEntry = mcsdMohAll.entry.find((mohEntry)=>{
                        return mohEntry.resource.id == mohParId
                      })
                      entityParent = mohParId
                      mcsd.getLocationParentsFromData(entityParent, mcsdMohAll, 'all', (mohParents) => {
                        var found = mohParents.find((parent) => {
                          if (parent.id === mohParId) {
                            datimMappedParentNames[entry.resource.id].push(parent.text);
                            return parent.text;
                          }
                        });
                        return found;
                      })
                    }
                  });
                  datimParentNames[entry.resource.id].push(parent.text);
                }
                else {
                  datimMappedParentNames[entry.resource.id].push(parent.text);
                  datimParentNames[entry.resource.id].push(parent.text);
                }
              });
            }
          });
        }
      }
      async.eachSeries(mcsdMOH.entry, (mohEntry, mohCallback) => {
        const database = config.getConf('mapping:dbPrefix') + datimTopId;
        // check if this MOH Orgid is mapped
        const mohId = mohEntry.resource.id;
        const mohIdentifier = URI(config.getConf('mCSD:url')).segment(datimTopId).segment('fhir').segment(mohId)
          .toString();
        var matchBroken = false
        if(mohEntry.resource.hasOwnProperty('tag')) {
          var matchBrokenTag = mohEntry.resource.tag.find((tag)=>{
          return tag.code == matchBrokenCode
          })
          if(matchBrokenTag) {
            matchBroken = true
          }
        }
	      this.matchStatus(mcsdMapped, mohIdentifier, (match) => {
	      	// if this MOH Org is already mapped
	      	if (match) {
	      		const noMatchCode = config.getConf('mapping:noMatchCode');
	      		var entityParent = null;
	      		if (mohEntry.resource.hasOwnProperty('partOf')) {
	      			entityParent = mohEntry.resource.partOf.reference;
	      		}
	      		mcsd.getLocationParentsFromData(entityParent, mcsdMohAll, 'names', (mohParents) => {
	      		// mcsd.getLocationParentsFromDB('MOH',mohDB,entityParent,mohTopId,"names",(mohParents)=>{
	      			const thisRanking = {};
              thisRanking.moh = {
                name: mohEntry.resource.name,
                parents: mohParents,
                id: mohEntry.resource.id,
              };
              thisRanking.potentialMatches = {};
              thisRanking.exactMatch = {};
              let noMatch = null;
              if (match.resource.hasOwnProperty('tag')) {
                noMatch = match.resource.tag.find(tag => tag.code == noMatchCode);
              }
              // in case this is marked as no match then process next MOH
              if (noMatch) {
                thisRanking.moh.tag = 'noMatch';
                scoreResults.push(thisRanking);
                count++;
                winston.error(`${count}/${mcsdMOH.entry.length}`);
                return mohCallback();
              }
              // if no macth then this is already marked as a match

              const flagCode = config.getConf('mapping:flagCode');
              if (match.resource.hasOwnProperty('tag')) {
                const flag = match.resource.tag.find(tag => tag.code == flagCode);
                if (flag) {
                  thisRanking.moh.tag = 'flagged';
                }
              }
              if (match.resource.hasOwnProperty('partOf')) {
                entityParent = match.resource.partOf.reference;
              }
              mcsd.getLocationParentsFromData(entityParent, mcsdDatimAll, 'names', (datimParents) => {
                // mcsd.getLocationParentsFromDB('DATIM',datimDB,entityParent,datimTopId,"names",(datimParents)=>{
                thisRanking.exactMatch = {
                  name: match.resource.name,
                  parents: datimParents,
                  id: match.resource.id,
                };
                scoreResults.push(thisRanking);
                count++;
                winston.error(`${count}/${mcsdMOH.entry.length}`);
                return mohCallback();
              });
            });
          } else { // if not mapped
            const mohName = mohEntry.resource.name;
            let mohParents = [];
            const mohParentNames = [];
            if (mohEntry.resource.hasOwnProperty('partOf')) {
              var entityParent = mohEntry.resource.partOf.reference;
              var mohParentReceived = new Promise((resolve, reject) => {
                mcsd.getLocationParentsFromData(entityParent, mcsdMohAll, 'all', (parents) => {
                  // mcsd.getLocationParentsFromDB('MOH',mohDB,entityParent,mohTopId,"all",(parents)=>{
                  mohParents = parents;
                  async.eachSeries(parents, (parent, nxtParent) => {
                    mohParentNames.push(
                      parent.text,
                    );
                    return nxtParent();
                  }, () => {
                    resolve();
                  });
                });
              });
            } else {
              var mohParentReceived = Promise.resolve([]);
            }

            mohParentReceived.then(() => {
              const thisRanking = {};
              thisRanking.moh = {
                name: mohName,
                parents: mohParentNames,
                id: mohEntry.resource.id,
              };
              thisRanking.potentialMatches = {};
              thisRanking.exactMatch = {};
              const datimPromises = [];
              async.each(mcsdDATIM.entry, (datimEntry, datimCallback) => {
                const database = config.getConf('mapping:dbPrefix') + datimTopId;
                const id = datimEntry.resource.id;
                var ignoreThis = ignore.find((toIgnore)=>{
                	return toIgnore == id
                })
                if(ignoreThis) {
                	return datimCallback()
                }
                // check if this is already mapped
                this.matchStatus(mcsdMapped, id, (mapped) => {
                  if (mapped) {
                  	ignore.push(datimEntry.resource.id)
                    return datimCallback();
                  }
                  const datimName = datimEntry.resource.name;
                  const datimId = datimEntry.resource.id
                  if (mohParentNames[0] != datimMappedParentNames[datimId][0]) {
                    return datimCallback();
                  }
                  lev = levenshtein.get(datimName, mohName);
                  // if names mathes exactly and the two has same parents then this is an exact match
                  // var parentsEquals = mohParents.length == datimParents.length &&  datimParents.every((v,i)=>mohParents.includes(v))
                  let parentsEquals = false;
                  if (mohParentNames.length > 0 && datimMappedParentNames[datimId].length > 0) {
                    parentsEquals = mohParentNames[0] == datimMappedParentNames[datimId][0];
                  }
                  if (lev == 0 && parentsEquals && !matchBroken) {
                  	ignore.push(datimEntry.resource.id)
                    if (Object.keys(datimMappedParentNames[datimId]).length == Object.keys(mohParents).length && datimMappedParentNames[datimId][0] == mohParentNames[0]) {
                      thisRanking.exactMatch = {
                        name: datimName,
                        parents: datimParentNames[datimId],
                        id: datimEntry.resource.id,
                      };
                      thisRanking.potentialMatches = {};
                    }
                    mcsd.saveMatch(mohId, datimEntry.resource.id, datimTopId, recoLevel, totalLevels, 'match', () => {

                    });
                    // we will need to break here and start processing nxt MOH
                    return datimCallback();
                  }
                  if (lev == 0 && parentsEquals && matchBroken) {
                    ignore.push(datimEntry.resource.id)
                    if (Object.keys(datimMappedParentNames[datimId]).length == Object.keys(mohParents).length && datimMappedParentNames[datimId][0] == mohParentNames[0]) {
                      thisRanking.potentialMatches = {'0': [{
                        name: datimName,
                        parents: datimParentNames[datimId],
                        id: datimEntry.resource.id,
                      }]};
                    }
                     if (mohName == 'Northern Zone'){
                    winston.error(mohParentNames[0] + ' ' + datimMappedParentNames[datimId][0])
                    winston.error(Object.keys(datimMappedParentNames[datimId]).length +'=='+ Object.keys(mohParents).length)
                    winston.error(JSON.stringify(mohParents))
                    winston.error(JSON.stringify(datimMappedParentNames[datimId]))
                  }
                    return datimCallback();
                  }
                  if (Object.keys(thisRanking.exactMatch).length == 0) {
                    if (thisRanking.potentialMatches.hasOwnProperty(lev) || Object.keys(thisRanking.potentialMatches).length < maxSuggestions) {
                      if (!thisRanking.potentialMatches.hasOwnProperty(lev)) {
                        thisRanking.potentialMatches[lev] = [];
                      }
                      thisRanking.potentialMatches[lev].push({
                        name: datimName,
                        parents: datimParentNames[datimId],
                        id: datimEntry.resource.id,
                      });
                    } else {
                      const existingLev = Object.keys(thisRanking.potentialMatches);
                      const max = _.max(existingLev);
                      if (lev < max) {
                        delete thisRanking.potentialMatches[max];
                        thisRanking.potentialMatches[lev] = [];
                        thisRanking.potentialMatches[lev].push({
                          name: datimName,
                          parents: datimParentNames[datimId],
                          id: datimEntry.resource.id,
                        });
                      }
                    }
                  }
                  return datimCallback();
                });
              }, () => {
                scoreResults.push(thisRanking);
                count++;
                winston.info(`${count}/${mcsdMOH.entry.length}`);
                return mohCallback();
              });
            }).catch((err) => {
              winston.error(err);
            });
          }
        });
      }, () => callback(scoreResults));
    },

    getBuildingsScores(mcsdMOH, mcsdDATIM, mcsdMapped, mcsdDatimAll, mcsdMohAll, mohDB, datimDB, mohTopId, datimTopId, recoLevel, totalLevels, callback) {
      var scoreResults = [];
      var mapped = [];
      const matchBrokenCode = config.getConf('mapping:matchBrokenCode');
      var maxSuggestions = config.getConf('matchResults:maxSuggestions');
      if (mcsdDATIM.total == 0) {
        winston.error('No DATIM data found for this orgunit');
        return callback();
      }
      if (mcsdMOH.total == 0) {
        winston.error('No MOH data found');
        return callback();
      }
      var counter = 0;
      var promises = [];
      var count = 0;
      var mohPromises = [];
      var datimParentNames = {}
      var datimMappedParentNames = {}
      for ( entry of mcsdDATIM.entry ) {
        if (entry.resource.hasOwnProperty('partOf')) {
          datimParentNames[entry.resource.id] = [];
          datimMappedParentNames[entry.resource.id] = [];
          var entityParent = entry.resource.partOf.reference;
          mcsd.getLocationParentsFromData(entityParent, mcsdDatimAll, 'all', (parents) => {
            // lets make sure that we use the mapped parent for comparing against MOH
            for( parent of parents ) {
              this.matchStatus(mcsdMapped, parent.id, (mapped) => {
                if (mapped) {
                  const mappedPar = mapped.resource.identifier.find((identifier) => {
                    if (identifier.system == 'http://geoalign.datim.org/MOH') {
                      const mohParId = identifier.value.split('/').pop();

                      var mohEntry = mcsdMohAll.entry.find((mohEntry)=>{
                        return mohEntry.resource.id == mohParId
                      })
                      entityParent = mohParId
                      mcsd.getLocationParentsFromData(entityParent, mcsdMohAll, 'all', (mohParents) => {
                        var found = mohParents.find((parent) => {
                          if (parent.id === mohParId) {
                            datimMappedParentNames[entry.resource.id].push(parent.text);
                            return parent.text;
                          }
                        });
                        return found;
                      })
                    }
                  });
                  datimParentNames[entry.resource.id].push(parent.text);
                }
                else {
                  datimMappedParentNames[entry.resource.id].push(parent.text);
                  datimParentNames[entry.resource.id].push(parent.text);
                }
              });
            }
          });
        }
      }
      async.each(mcsdMOH.entry, (mohEntry, mohCallback) => {
        const database = config.getConf('mapping:dbPrefix') + datimTopId;
        // check if this MOH Orgid is mapped
        const mohId = mohEntry.resource.id;
        const mohIdentifiers = mohEntry.resource.identifier;
        let mohLatitude = null;
        let mohLongitude = null;
        if (mohEntry.resource.hasOwnProperty('position')) {
          mohLatitude = mohEntry.resource.position.latitude;
          mohLongitude = mohEntry.resource.position.longitude;
        }
        const mohIdentifier = URI(config.getConf('mCSD:url')).segment(datimTopId).segment('fhir').segment(mohId)
          .toString();

        var matchBroken = false
        if(mohEntry.resource.hasOwnProperty('tag')) {
          var matchBrokenTag = mohEntry.resource.tag.find((tag)=>{
          return tag.code == matchBrokenCode
          })
          if(matchBrokenTag) {
            matchBroken = true
          }
        }
	      this.matchStatus(mcsdMapped, mohIdentifier, (match) => {
	      	// if this MOH Org is already mapped
	      	const thisRanking = {};
	      	if (match) {
	      		const noMatchCode = config.getConf('mapping:noMatchCode');
	      		var entityParent = null;
	      		if (mohEntry.resource.hasOwnProperty('partOf')) {
	      			entityParent = mohEntry.resource.partOf.reference;
	      		}
	      		mcsd.getLocationParentsFromData(entityParent, mcsdMohAll, 'names', (mohParents) => {
	      			const ident = mohEntry.resource.identifier.find(identifier => identifier.system == 'http://geoalign.datim.org/MOH');

              let mohBuildingId = null;
              if (ident) {
                mohBuildingId = ident.value;
              }
              thisRanking.moh = {
                name: mohEntry.resource.name,
                parents: mohParents,
                lat: mohLatitude,
                long: mohLongitude,
                id: mohBuildingId,
              };
              thisRanking.potentialMatches = {};
              thisRanking.exactMatch = {};
              let noMatch = null;
              if (match.resource.hasOwnProperty('tag')) {
                noMatch = match.resource.tag.find(tag => tag.code == noMatchCode);
              }
              // in case this is marked as no match then process next MOH
              if (noMatch) {
                thisRanking.moh.tag = 'noMatch';
                scoreResults.push(thisRanking);
                return mohCallback();
              }

              //if this is flagged then process next MOH
              const flagCode = config.getConf('mapping:flagCode');
              if (match.resource.hasOwnProperty('tag')) {
                const flag = match.resource.tag.find(tag => tag.code == flagCode);
                if (flag) {
                  thisRanking.moh.tag = 'flagged';
                }
              }

              if (match.resource.hasOwnProperty('partOf')) {
                entityParent = match.resource.partOf.reference;
              }

              mcsd.getLocationParentsFromData(entityParent, mcsdDatimAll, 'names', (datimParents) => {
                const ident = mohEntry.resource.identifier.find(identifier => identifier.system == 'http://geoalign.datim.org/MOH');

                let mohBuildingId = null;
                if (ident) {
                  mohBuildingId = ident.value;
                }
                thisRanking.exactMatch = {
                  name: match.resource.name,
                  parents: datimParents,
                  id: match.resource.id,
                };
                scoreResults.push(thisRanking);
                return mohCallback();
              });
            });
     	  } else { // if not mapped
            const mohName = mohEntry.resource.name;
            let mohParents = [];
            const mohParentNames = [];
            if (mohEntry.resource.hasOwnProperty('partOf')) {
              var entityParent = mohEntry.resource.partOf.reference;
              var mohParentReceived = new Promise((resolve, reject) => {
                mcsd.getLocationParentsFromData(entityParent, mcsdMohAll, 'all', (parents) => {
                  mohParents = parents;
                  async.eachSeries(parents, (parent, nxtParent) => {
                    mohParentNames.push(
                      parent.text,
                    );
                    return nxtParent();
                  }, () => {
                    resolve();
                  });
                });
              });
            } else {
              var mohParentReceived = Promise.resolve([]);
            }

            mohParentReceived.then(() => {
              const thisRanking = {};
              let mohBuildingId = null;
              const ident = mohEntry.resource.identifier.find(identifier => identifier.system == 'http://geoalign.datim.org/MOH');
              if (ident) {
                mohBuildingId = ident.value;
              }
              thisRanking.moh = {
                name: mohName,
                parents: mohParentNames,
                lat: mohLatitude,
                long: mohLongitude,
                id: mohBuildingId,
              };
              thisRanking.potentialMatches = {};
              thisRanking.exactMatch = {};
              const datimPromises = [];
              async.each(mcsdDATIM.entry, (datimEntry, datimCallback) => {
                const database = config.getConf('mapping:dbPrefix') + datimTopId;
                const id = datimEntry.resource.id;
                const datimIdentifiers = datimEntry.resource.identifier;
                // check if this is already mapped
                this.matchStatus(mcsdMapped, id, (mapped) => {
                  if (mapped) {
                    return datimCallback();
                  }
                  const datimName = datimEntry.resource.name;
                  let datimLatitude = null;
                  let datimLongitude = null;
                  if (datimEntry.resource.hasOwnProperty('position')) {
                    datimLatitude = datimEntry.resource.position.latitude;
                    datimLongitude = datimEntry.resource.position.longitude;
                  }
                    /*
                  let datimParents = [];
                  const datimParentNames = [];
                  const datimMappedParentNames = [];
                  let entityParent = null;
                  const me = this;
                  function modifyParents(parents, callback) {
                    datimParents = parents;
                    // lets make sure that we use the mapped parent for comparing against MOH
                    async.eachSeries(parents, (parent, nxtParent) => {
                      me.matchStatus(mcsdMapped, parent.id, (mapped) => {
                        if (mapped) {
                          const mappedPar = mapped.resource.identifier.find((identifier) => {
                            if (identifier.system == 'http://geoalign.datim.org/MOH') {
                              const mohParId = identifier.value.split('/').pop();
                              var found = mohParents.find((parent) => {
                                if (parent.id === mohParId) {
                                  datimMappedParentNames.push(parent.text);
                                  return parent.text;
                                }
                              });
                            }
                            return found;
                          });
                          datimParentNames.push(parent.text);
                          return nxtParent();
                        }
                        datimMappedParentNames.push(parent.text);
                        datimParentNames.push(parent.text);
                        return nxtParent();
                      });
                    }, () => callback());
                  }
                  if (datimEntry.resource.hasOwnProperty('partOf')) {
                    entityParent = datimEntry.resource.partOf.reference;
                  }
                  */

                  //mcsd.getLocationParentsFromData(entityParent, mcsdDatimAll, 'all', (parents) => {
                    //modifyParents(parents, () => {
                      if (mohParentNames[0] != datimMappedParentNames[datimEntry.resource.id][0]) {
                        return datimCallback();
                      }
                      // get distance between the coordinates
                      if (datimLatitude && datimLongitude) {
                        var dist = geodist({ datimLatitude, datimLongitude }, { mohLatitude, mohLongitude }, { exact: false, unit: 'miles' });
                      }
                      datimIdPromises = [];

                      // check if IDS are the same and mark as exact match
                      const matchingIdent = datimIdentifiers.find(datIdent => mohIdentifiers.find(mohIdent => datIdent.value == mohIdent.value));
                      if (matchingIdent && !matchBroken) {
                        thisRanking.exactMatch = {
                          name: datimName,
                          parents: datimParentNames[datimEntry.resource.id],
                          lat: datimLatitude,
                          long: datimLongitude,
                          geoDistance: dist,
                          id: datimEntry.resource.id,
                        };
                        thisRanking.potentialMatches = {};
                        // msg = {mohId,datimId:datimEntry.resource.id,topOrgId:datimTopId,recoLevel,totalLevels,type:'match'}
                        // save.send(msg)
                        mcsd.saveMatch(mohId, datimEntry.resource.id, datimTopId, recoLevel, totalLevels, 'match', () => {

                        });
                        return datimCallback();
                      }
                      else if (matchingIdent && matchBroken) {
                        thisRanking.potentialMatches = {'0': [{
                          name: datimName,
                          parents: datimParentNames[datimEntry.resource.id],
                          lat: datimLatitude,
                          long: datimLongitude,
                          geoDistance: dist,
                          id: datimEntry.resource.id,
                        }]};
                        return datimCallback();
                      }

                      lev = levenshtein.get(datimName, mohName);
                      // if names mathes exactly and the two has same parents then this is an exact match
                      let parentsEquals = false;
                      if (mohParentNames.length > 0 && datimMappedParentNames[datimEntry.resource.id].length > 0) {
                        parentsEquals = mohParentNames[0] == datimMappedParentNames[datimEntry.resource.id][0];
                      }
                      if (lev == 0 && parentsEquals && !matchBroken) {
                        thisRanking.exactMatch = {
                          name: datimName,
                          parents: datimParentNames[datimEntry.resource.id],
                          lat: datimLatitude,
                          long: datimLongitude,
                          geoDistance: dist,
                          id: datimEntry.resource.id,
                        };
                        thisRanking.potentialMatches = {};
                        mcsd.saveMatch(mohId, datimEntry.resource.id, datimTopId, recoLevel, totalLevels, 'match', () => {

                        });
                        return datimCallback();
                      }
                      else if (lev == 0 && parentsEquals && matchBroken) {
                        thisRanking.potentialMatches = {'0': [{
                          name: datimName,
                          parents: datimParentNames[datimEntry.resource.id],
                          lat: datimLatitude,
                          long: datimLongitude,
                          geoDistance: dist,
                          id: datimEntry.resource.id,
                        }]};
                        return datimCallback();
                      }
                      if (Object.keys(thisRanking.exactMatch).length == 0) {
                        if (thisRanking.potentialMatches.hasOwnProperty(lev) || Object.keys(thisRanking.potentialMatches).length < maxSuggestions) {
                          if (!thisRanking.potentialMatches.hasOwnProperty(lev)) {
                            thisRanking.potentialMatches[lev] = [];
                          }
                          thisRanking.potentialMatches[lev].push({
                            name: datimName,
                            parents: datimParentNames[datimEntry.resource.id],
                            lat: datimLatitude,
                            long: datimLongitude,
                            geoDistance: dist,
                            id: datimEntry.resource.id,
                          });
                        } else {
                          const existingLev = Object.keys(thisRanking.potentialMatches);
                          const max = _.max(existingLev);
                          if (lev < max) {
                            delete thisRanking.potentialMatches[max];
                            thisRanking.potentialMatches[lev] = [];
                            thisRanking.potentialMatches[lev].push({
                              name: datimName,
                              parents: datimParentNames[datimEntry.resource.id],
                              lat: datimLatitude,
                              long: datimLongitude,
                              geoDistance: dist,
                              id: datimEntry.resource.id,
                            });
                          }
                        }
                      }
                      return datimCallback();
                    //});
                  //});
                });
              }, () => {
                scoreResults.push(thisRanking);
                count++;
                winston.info(`${count}/${mcsdMOH.entry.length}`);
                return mohCallback();
              });
            }).catch((err) => {
              winston.error(err);
            });
          }
        });
      }, () => callback(scoreResults));
    },
    matchStatus(mcsdMapped, id, callback) {
      if (mcsdMapped.length === 0 || !mcsdMapped) {
        return callback();
      }
      const status = mcsdMapped.entry.find(entry => entry.resource.id === id || (entry.resource.hasOwnProperty('identifier') && entry.resource.identifier.find(identifier => identifier.value === id)));
      return callback(status);
    },
    getUnmatched(mcsdDatimAll, mcsdDatim, topOrgId, callback) {
      const database = config.getConf('mapping:dbPrefix') + topOrgId;
      const unmatched = [];
      async.each(mcsdDatim.entry, (datimEntry, datimCallback) => {
        mcsd.getLocationByID(database, datimEntry.resource.id, false, (location) => {
          if (location.entry.length == 0) {
            const name = datimEntry.resource.name;
            const id = datimEntry.resource.id;
            let entityParent = null;
            if (datimEntry.resource.hasOwnProperty('partOf')) {
              entityParent = datimEntry.resource.partOf.reference;
            }
            mcsd.getLocationParentsFromData(entityParent, mcsdDatimAll, 'names', (datimParents) => {
              unmatched.push({
                id,
                name,
                parents: datimParents,
              });
              return datimCallback();
            });
          } else {
            return datimCallback();
          }
        });
      }, () => {
        callback(unmatched);
      });
    },

  };
};