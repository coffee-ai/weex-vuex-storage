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
  key: 'rootKey', // 根节点的key
  supportRegister: true, // 支持registerModule和unregisterModule时读取、删除本地数据
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
    someAction({commit}) {

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
    getStateData() {
      getState({
        namespace: 'A/',
        store: this.$store
      }).then(state => {
        console.log(state);
      })
    }
  }
}
```

获取storage快照数据，导入快照数据至storage并同步更新module的state

**view.vue**

```javascript
import {getModuleMap, loadStore} from 'weex-vuex-storage';
export default {
  methods: {
    getStorageSnapshot() {
      // 获取快照数据
      getModuleMap({
        namespace: 'A/',
        store: this.$store
      }).then((snapshot) => {})
    },
    loadSnapshot() {
      // 导入快照数据，并更新对应state
      // 快照数据可由getModuleMap导出，key由createStatePlugin时填写
      loadStore(this.$store, ['A'], {
        `${key}/A/`: '{"a": 1}',
        `${key}/A/B`: '{"b": "foo"}'
      }, {
        onlyState: false, // 是否需要覆盖到storage
        removeList: [], // 需要移除的storage key，只在onlyState为true时生效
        reserveList: [], // 需要保留的storage key，只在onlyState为true时生效
        isReplace: true, // 是否全量替换module的state，需要module中的state为函数而非对象
      }).then(() => {})
    }
  }
}
```