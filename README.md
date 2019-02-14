# weex-vuex-storage

依据Vuex的module来存储数据到storage

## install

```
npm install weex-vuex-storage -S
```

**store.js**
```javascript
import {createStatePlugin} from 'weex-vuex-storage';
const plugins = [];
plugins.push(createStatePlugin({
  intercept: function(init) {
    router.beforeEach((from, to, next) => {
      init.then(next);
    });
  }
}));
export default new Vuex.Store({
  ...
  plugins,
})
```
**module.js**
```javascript
import {setState} from 'weex-vuex-storage';
const module = {
  ...
  actions: {
    @setState,
    someActions({commit}) {

    }
  }
}
```

**view.vue**
```javascript
import {getState} from 'weex-vuex-storage';
export default {
  methods: {
    // module A storage data
    getState({
      namespace: 'A/',
      store: this.$store
    }).then(state => {
      console.log(state);
    })
  }
}
```