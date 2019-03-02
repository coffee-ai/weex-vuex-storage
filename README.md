# weex-vuex-storage

依据Vuex的module来存储数据到storage

## install

```
npm install weex-vuex-storage -S
```

## use

加载vuex插件
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

给action添加修饰器，调用action时存储当前module的state到storage，同时给需要存储的state属性添加到黑白名单，不能在同一个module中同时使用`shouldWrite`和`forbidWrite`
**module.js**
```javascript
import {setState, shouldWrite, forbidWrite} from 'weex-vuex-storage';
const module = {
  ...
  state: {
    @shouldWrite
    someState: {}
  },
  actions: {
    @setState,
    someActions({commit}) {

    }
  }
}
```


也可以手动获取storage中的数据
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