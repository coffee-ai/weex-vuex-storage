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

const moduleWeakMap = new WeakMap();
const hashTagMap = new WeakMap();
// 存储storage对象的黑白名单
const descriptorSet = new WeakSet();

const storage = (() => {
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
          return resolve(result);
        })
      })
    }
  };
  return {
    getItem: fn('getItem'),
    setItem: fn('setItem'),
    removeItem: fn('removeItem'),
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

const getStateData = async function getModuleState(module, path = [], setMap = false) {
  const moduleKey = normalizeNamespace(path);
  const {_children, context} = module;
  if (setMap) {
    const {commit} = context || {};
    moduleWeakMap.set(commit, {module, moduleKey});
  }
  const data = parseJSON(await storage.getItem(moduleKey)) || {};
  const children = entries(_children);
  if (!children.length) {
    return data;
  }
  const childModules = await Promise.all(
    children.map(async ([childKey, child]) => {
      return [childKey, await getModuleState(child, path.concat(childKey), setMap)];
    })
  );
  return {
    ...data,
    ...fromEntries(childModules),
  }
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

/**
 * [根据黑白名单，解析module和state的映射关系]
 * @param  {[type]} module [description]
 * @param  {[type]} state  [description]
 * @return {[type]}        [description]
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

export const shouldWrite = descriptorFactory(USE_WHITE_TAG);
export const forbidWrite = descriptorFactory(USE_BLACK_TAG);

export const getState = async ({commit, namespace, store}) => {
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
      return getStateData(module, path);
    }
  }
  if (typeof commit === 'function') {
    const {module, moduleKey} = moduleWeakMap.get(commit) || {};
    if (moduleKey) {
      const path = moduleKey.split('/').filter(a => a);
      return getStateData(module, path);
    }
  }
  return undefined;
};

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
 * 根据module，替换storage里的state
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
 * 替换Vuex里module的state
 * 若无newState，则取storage
 */
export const setModuleState = async (store, path, newState) => {
  const namespace = path.length ? normalizeNamespace(path) : '';
  const module = store._modulesNamespaceMap[namespace];
  newState = newState || await getStateData(module, [rootKey, ...path], true);
  const setChildModuleState = function setChildModuleState(_module, _state) {
    const {_children, state} = _module;
    const childrenKeys = Object.keys(_children);
    entries(_state).map(([key, value]) => {
      // 后续看能否将state修改放到mutation里
      if (childrenKeys.every(a => a !== key)) {
        state[key] = value;
      } else if (_children[key]) {
        setChildModuleState(_children[key], _state[key]);
      }
    });
  };
  setChildModuleState(module, newState);
};

export const removeModuleState = async (store, path) => {
  const namespace = path.length ? normalizeNamespace(path) : '';
  const module = store._modulesNamespaceMap[namespace];
  const moduleKeys = [];
  const removeChildModuleState = function removeChildModuleState(_module, _path) {
    const {_children = {}} = _module;
    moduleKeys.push(normalizeNamespace(path));
    entries(_children).forEach(([childKey, childModule]) => {
      removeChildModuleState(childModule, _path.concat(childKey));
    });
  };
  removeChildModuleState(module, [rootKey, ...path]);
  return Promise.all(moduleKeys.map(async key => {
    await storage.removeItem(key);
  }));
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
      };
    }
    const init = getStateData(store._modules.root, [rootKey], true).then(savedState => {
      store.replaceState(merge(store.state, savedState));
    }).catch(() => {});
    intercept(init);
  };
};

export const startApp = runInterceptor;