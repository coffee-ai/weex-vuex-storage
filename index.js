import fromEntries from 'object.fromentries';
import {registerInterceptor, runInterceptor} from './src/intercept';
import Promise from 'promise/lib/es6-extensions';
import defaultIsMergeableObject from 'is-mergeable-object';
import WeakSet from 'core-js/es6/weak-set';
import WeakMap from 'core-js/es6/weak-map';
import getOwnPropertyDescriptors from 'object.getownpropertydescriptors';
import entries from 'object.entries';

let rootKey = 'storage';

const USE_WHITE_TAG = 1;
const USE_BLACK_TAG = 2;

const moduleWeakMap = new Map();
const hashTagMap = new WeakMap();
// 存储storage对象的黑白名单
const descriptorSet = new WeakSet();

const storage = (() => {
  if (typeof weex !== 'undefined' && typeof weex.requireModule === 'function') {
    const _storage = weex.requireModule('storage');
    const fn = (key) => {
      return function(...args) {
        const [callback] = args.slice(-1);
        const innerArgs = typeof callback === 'function' ? args.slice(0, -1) : args;
        return new Promise((resolve, reject) => {
          _storage[key].call(_storage, ...innerArgs, ({result, data}) => {
            if (result === 'success') {
              return resolve(data);
            }
            // 防止module无保存state而出现报错
            return resolve('{}');
          })
        })
      }
    };
    return {
      getItem: fn('getItem'),
      setItem: fn('setItem'),
      removeItem: fn('removeItem'),
    }
  } else {
    return window.localStorage;
  }
})();

const isPromise = fn => {
  return typeof fn !== 'undefined' && typeof fn.then === 'function';
};

const parseJSON = str => {
  try {
    return str ? JSON.parse(str) : undefined;
  } catch (e) {}
  return undefined;
};

const normalizeNamespace = path => `${path.join('/')}/`;
const normalizeModule = ({commit, namespace, store}) => {
  if (typeof namespace === 'string' && store) {
    let module;
    if (namespace === '') {
      module = store._modules.root;
    } else {
      module = store._modulesNamespaceMap[namespace];
    }
    if (module) {
      const path = [
        rootKey,
        ...namespace.split('/').filter(a => a)
      ];
      return {module, path};
    }
  }
  if (typeof commit === 'function') {
    const {module, moduleKey} = moduleWeakMap.get(commit) || {};
    if (moduleKey) {
      const path = moduleKey.split('/').filter(a => a);
      return {module, path};
    }
  }
  return {};
};


const defaultArrayMerge = (target, source) => source;

const mergeObject = (target, source, options) => {
  Object.keys(source).forEach(key => {
    if (!options.isMergeableObject(source[key]) || !target[key]) {
      target[key] = source[key];
    } else {
      target[key] = merge(target[key], source[key], options);
    }
  })
  return target
};
const merge = (target, source, options) => {
  options = options || {}
  options.arrayMerge = options.arrayMerge || defaultArrayMerge
  options.isMergeableObject = options.isMergeableObject || defaultIsMergeableObject

  const sourceIsArray = Array.isArray(source)
  const targetIsArray = Array.isArray(target)
  const sourceAndTargetTypesMatch = sourceIsArray === targetIsArray

  if (!sourceAndTargetTypesMatch) {
    return source;
  } else if (sourceIsArray) {
    return options.arrayMerge(target, source, options)
  } else {
    return mergeObject(target, source, options)
  }
};

const getStateData = async function getModuleState(module, storagePath = []) {
  const moduleKey = normalizeNamespace(storagePath);
  const {_children} = module;
  const data = parseJSON(await storage.getItem(moduleKey)) || {};
  const children = entries(_children);
  if (!children.length) {
    return data;
  }
  const childModules = await Promise.all(
    children.map(async ([childKey, child]) => {
      return [childKey, await getModuleState(child, storagePath.concat(childKey))];
    })
  );
  return {
    ...data,
    ...fromEntries(childModules),
  }
};

const getStateMap = async function getModuleStateMap(module, storagePath = [], output = {}) {
  const moduleKey = normalizeNamespace(storagePath);
  const data = await storage.getItem(moduleKey);
  if (data !== '{}') {
    output[moduleKey] = data;
  }
  const {_children} = module;
  const children = entries(_children);
  if (children.length) {
    await Promise.all(children.map(async ([childKey, child]) => {
      await getModuleStateMap(child, storagePath.concat(childKey), output);
    }))
  }
  return output;
};
/**
 * 将键值对快照转成数据对象结构
 */
const normalizeStateFromSnapshot = (store, path, snapshot) => {
  const rootPathString = normalizeNamespace([rootKey, ...path]);
  const {[rootPathString]: rootValue, ...rest} = snapshot;
  const length = rootPathString.length;
  // 找到根节点
  const output = typeof rootValue === 'string' ? (parseJSON(rootValue) || {}) : {};
  // 对namespace的长度升序处理，确保先加载父模块数据
  Object.keys(rest).sort((a, b) => a.length - b.length).forEach(key => {
    if (key.indexOf(rootPathString) === 0) {
      const dataPath = key.slice(length).split('/').filter(Boolean);
      const len = dataPath.length
      if (len) {
        const dataValue = rest[key];
        dataPath.reduce((data, key, index) => {
          if (index === len - 1) {
            return (data[key] = parseJSON(dataValue) || {});
          } else {
            return data[key] || (data[key] = {});
          }
        }, output);
      }
    }
  });
  return output;
}
/**
 * 获取当前module对应的storage快照keys
 */
const getModuleSnapshotKeys = (store, path) => {
  const namespace = path.length ? normalizeNamespace(path) : '';
  const module = store._modulesNamespaceMap[namespace];
  const moduleKeys = [];
  const collectKeys = function collectKeys(_module, storagePath) {
    const {_children = {}} = _module;
    moduleKeys.push(normalizeNamespace(storagePath));
    entries(_children).forEach(([childKey, childModule]) => {
      collectKeys(childModule, storagePath.concat(childKey));
    });
  };
  collectKeys(module, [rootKey, ...path]);
  return moduleKeys;
};

const descriptorFactory = (USE_TAG) => (target, name) => {
  if (!hashTagMap.has(target)) {
    hashTagMap.set(target, USE_TAG);
  } else {
    let tag = hashTagMap.get(target);
    tag = tag | USE_TAG; // 启用黑白名单标志
    if (tag & USE_WHITE_TAG && tag & USE_BLACK_TAG) {
      throw new Error('can\'t set blacklist and whitelist at the same time in one module');
    }
  }
  let value = target[name];
  return {
    enumerable: true,
    configurable: true,
    get: function() {
      const {get: getter} = Object.getOwnPropertyDescriptor(target, name);
      if (!descriptorSet.has(getter)) {
        descriptorSet.add(getter); // 放入Set，setState时判断是否需要存入storage
      }
      return value;
    },
    set: function(newVal) {
      value = newVal;
    }
  };
};

export const shouldWrite = descriptorFactory(USE_WHITE_TAG);
export const forbidWrite = descriptorFactory(USE_BLACK_TAG);
/**
 * action修饰器，根据黑白名单触发storage的setItem操作
 */
export const setState = (target, name, descriptor) => {
  const fn = descriptor.value;
  descriptor.value = function(...args) {
    const [{state, commit}] = args;
    const oldValue = fn.apply(this, args);
    if (!isPromise(oldValue)) {
      throw new Error(`setState must decorate a promise function`);
    }
    return oldValue.then(async data => {
      const {module, moduleKey} = moduleWeakMap.get(commit) || {};
      if (module) {
        const pureState = parseModuleState(module, state);
        await storage.setItem(moduleKey, JSON.stringify(pureState));
      }
      return data;
    });
  };
  return descriptor;
};

/**
 * 解析各module，moduleKey和commit的关系，并存入moduleWeakMap
 */
export const parseModuleCommit = (module, storagePath) => {
  const moduleKey = normalizeNamespace(storagePath);
  const {_children, context} = module;
  const {commit} = context || {};
  moduleWeakMap.set(commit, {module, moduleKey});
  entries(_children).forEach(([childKey, child]) => {
    parseModuleCommit(child, storagePath.concat(childKey));
  });
};

/**
 * 根据黑白名单，获取当前module的state，不包括子模块的state
 */
export const parseModuleState = (module, state) => {
  const {_children, state: moduleState} = module;
  const childrenKeys = Object.keys(_children);
  const descriptors = getOwnPropertyDescriptors(moduleState);
  const tag = hashTagMap.get(moduleState) || USE_BLACK_TAG; // 默认黑名单
  const isWhiteTag = tag & USE_WHITE_TAG;
  const pureState = fromEntries(entries(state).filter(([stateKey]) => {
    const {get: getter} = descriptors[stateKey] || {};
    return !childrenKeys.some(childKey => childKey === stateKey) 
      && !((isWhiteTag ^ descriptorSet.has(getter)));
  }));
  return pureState;
};
/**
 * 设置store里module的state
 * 若无newState，则取storage
 */
export const setModuleState = async (store, path, newState, isReplace = false) => {
  const namespace = path.length ? normalizeNamespace(path) : '';
  const module = store._modulesNamespaceMap[namespace];
  // 收集commit与module的映射关系
  parseModuleCommit(module, [rootKey, ...path]);
  newState = newState || await getStateData(module, [rootKey, ...path]);
  // TODO 根据newState进行state的全量更新替换
  const setChildModuleState = function setChildModuleState(_module, _state) {
    const {_children, state, _rawModule} = _module;
    const childrenKeys = Object.keys(_children);
    if (isReplace) {
      const {state: stateFn} = _rawModule || {};
      // 函数构造state，便于快照替换数据时回滚到初始值
      if (typeof stateFn === 'function') {
        const defaultState = stateFn();
        _state = mergeObject(defaultState, _state, {isMergeableObject: defaultIsMergeableObject});
      }
    }
    entries(_state).map(([key,]) => {
      if (_children[key]) {
        childrenKeys.splice(childrenKeys.indexOf(key), 1);
        setChildModuleState(_children[key], _state[key] || {});
      } else if (_state.hasOwnProperty(key)) {
        // 后续看能否将state修改放到mutation里
        state[key] = _state[key];
      }
    });
    if (isReplace) {
      // 初始化其余模块数据
      childrenKeys.forEach(key => {
        setChildModuleState(_children[key], {});
      })
    }
  };
  setChildModuleState(module, newState);
};

/**
 * 根据module，获取storage里的数据对象，包括子模块
 */
export const getState = async ({commit, namespace, store}) => {
  const {module, path} = normalizeModule({commit, namespace, store});
  if (module && path) {
    return getStateData(module, path);
  }
  return undefined;
};
/**
 * 根据module，获取storage里存储的数据键值对，包括子模块
 * 用以保存storage快照用
 */
export const getModuleMap = async ({commit, namespace, store}) => {
  const {module, path} = normalizeModule({commit, namespace, store});
  if (module && path) {
    return getStateMap(module, path);
  }
  return undefined;
};
/**
 * 根据store的path，设置模块对应的storage数据
 */
export const replaceModuleState = async function replaceModuleState(module, path, newState) {
  if (typeof newState !== 'object') {
    throw new Error(`[weex-vuex-storage]: can\'t replaceModuleState with non-object`);
  }
  if (module) {
    const pureState = parseModuleState(module, newState);
    await storage.setItem(normalizeNamespace([rootKey, ...path]), JSON.stringify(pureState));
    return Promise.all(entries(module._children).map(async ([childKey, child]) => {
      return await replaceModuleState(child, [...path, childKey], newState[childKey] || {});
    }));
  }
};
/**
 * 根据store的path，清空模块对应的storage数据
 */
export const removeModuleState = async (store, path) => {
  const moduleKeys = getModuleSnapshotKeys(store, path);
  return Promise.all(moduleKeys.map(async key => {
    await storage.removeItem(key);
  }));
};

export const loadStore = async (store, path, snapshot, option = {}) => {
  /**
   * 是否只保存到state
   */
  const {onlyState = false, reserveList = [], removeList = [], isReplace = true} = option;
  if (!onlyState) {
    const storageKeys = getModuleSnapshotKeys(store, path);
    const snapshotKeys = Object.keys(snapshot);
    const removeKeys = Array.from(new Set(
      storageKeys.filter(key => snapshotKeys.every(a => a !== key))
        .concat(removeList)
        .filter(key => reserveList.every(a => a !== key))
    ));
    await Promise.all([
      // 差集remove
      ...removeKeys.map(async (key) => {
        return await storage.removeItem(key);
      }),
      ...snapshotKeys.map(async (key) => {
        return storage.setItem(key, snapshot[key]);
      })
    ]);
  }
  // 重置store
  const newState = normalizeStateFromSnapshot(store, path, snapshot);
  await setModuleState(store, path, newState, isReplace);
};

export const createStatePlugin = (option = {}) => {
  const {key, intercept = registerInterceptor, supportRegister = false} = option;
  key && (rootKey = key);
  return function(store) {
    if (supportRegister) {
      const registerModule = store.registerModule;
      const unregisterModule = store.unregisterModule;
      store.registerModule = async function(path, rawModule, options) {
        registerModule.call(store, path, rawModule, options);
        const {rawState} = options || {};
        const newState = typeof rawState === 'function' ? rawState() : rawState;
        await setModuleState(store, path, newState);
        if (newState) {
          const module = store._modulesNamespaceMap[normalizeNamespace(path)];
          // 存储数据到storage
          return await replaceModuleState(module, path, newState);
        }
      };

      store.unregisterModule = async function(path) {
        await removeModuleState(store, path);
        unregisterModule.call(store, path);
        // unregisterModule会调用resetStore，导致各module的commit重置
        // 需要重新梳理module的commit映射关系
        parseModuleCommit(store._modules.root, [rootKey]);
      };
    }
    parseModuleCommit(store._modules.root, [rootKey]);
    const init = getStateData(store._modules.root, [rootKey]).then(savedState => {
      store.replaceState(merge(store.state, savedState));
    }).catch(() => {});
    intercept(init);
  };
};

export const startApp = runInterceptor;