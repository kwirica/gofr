// The Vue build version to load with the `import` command
// (runtime-only or standalone) has been set in webpack.base.conf with an alias.
import Vue from 'vue'
import App from './App'
import router from './router'
import Vuetify from 'vuetify'
import Vuelidate from 'vuelidate'
import 'vuetify/dist/vuetify.min.css'
import axios from 'axios'
import guiConfig from '../config/config.json'
import {
  store
} from './store/store'
import i18n from './i18n'

Vue.use(Vuelidate)
Vue.use(Vuetify, {
  theme: {
    primary: '#3F51B5',
    secondary: '#7986CB',
    accent: '#9c27b0',
    error: '#f44336',
    warning: '#ffeb3b',
    info: '#2196f3',
    success: '#4caf50'
  }
})

Vue.config.productionTip = false

export const eventBus = new Vue()

// if running inside DHIS2 then get any config defined inside the datastore
function getDHIS2StoreConfig (callback) {
  let href = location.href.split('api')
  if (href.length < 2) {
    let dhis2URL = location.href.split('api').shift()
    axios.get(dhis2URL + '/api/dataStore/GOFR/config').then((response) => {
      return callback(response.data)
    }).catch((err) => {
      console.log(JSON.stringify(err))
      let resp = false
      return callback(resp)
    })
  } else {
    let resp = false
    return callback(resp)
  }
}
/* eslint-disable no-new */
getDHIS2StoreConfig((storeConfig) => {
  if (storeConfig && storeConfig.BACKEND_SERVER) {
    axios.defaults.baseURL = process.env.BACKEND_SERVER || storeConfig.BACKEND_SERVER
  } else {
    axios.defaults.baseURL = process.env.BACKEND_SERVER || guiConfig.BACKEND_SERVER
  }
  // get general config of App and pass it to the App component as props
  let defaultGenerConfig = JSON.stringify(store.state.config.generalConfig)
  axios.get('/getGeneralConfig?defaultGenerConfig=' + defaultGenerConfig).then(genConfig => {
    if (!genConfig) {
      genConfig.data = {}
    }
    new Vue({
      el: '#app',
      router,
      store,

      components: {
        App
      },
      data () {
        return {
          config: genConfig.data
        }
      },

      i18n,
      template: '<App :generalConfig="config" />'
    })
  })
})
