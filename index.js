import fromEntries from 'object.fromentries';
import {registerInterceptor, runInterceptor} from './src/intercept';
import Promise from 'promise/lib/es6-extensions';
import defaultIsMergeableObject from 'is-mergeable-object'

let rootKey = 'storage';

const USE_WHITE_TAG = 1;
const USE_BLACK_TAG = 2;

const moduleWeakMap = new WeakMap();
const hashTagMap = new WeakMap();
// 存储storage对象的黑白名单
const descriptorSet = new WeakSet();

const storage = (() => {
  if (typeof weex !== 'undefined') {
    return new Proxy(
      weex.requireModule('storage'),
      {
        get: function(target, prop) {
          const fn = Reflect.get(target, prop);
          if ([
            'getItem',
            'setItem',
          ].some(method => method === prop)) {
            return function(...args) {
              const [callback] = args.slice(-1);
              const innerArgs = typeof callback === 'function' ? args.slice(0, -1) : args;
              return new Promise((resolve, reject) => {
                fn.call(target, ...innerArgs, ({result, data}) => {
                  if (result === 'success') {
                    return resolve(data);
                  }
                  // 防止module无保存state而出现报错
                  return resolve(result);
                })
              })
            }
          }
          return fn;
        }
      }
    );
  } else if (typeof window !== 'undefined' && window.localStorage) {
    const localStorage = window.localStorage;
    return new Proxy(
      localStorage,
      {
        get: function(target, prop) {
          const fn = Reflect.get(target, prop);
          return function(...args) {
            const rst = fn.apply(localStorage, args);
            return Promise.resolve(rst);
          }
        }
      }
    )
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
  const moduleKey = `${path.join('/')}/`;
  const {_children, context} = module;
  if (setMap) {
    const {commit} = context || {};
    moduleWeakMap.set(commit, {module, moduleKey});
  }
  const data = parseJSON(await storage.getItem(moduleKey)) || {};
  const children = Object.entries(_children);
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
    const [{state, commit, getters}] = args;
    const oldValue = fn.apply(this, args);
    if (!isPromise(oldValue)) {
      throw new Error(`setState must decorate a promise function`);
    }
    return oldValue.then(async data => {
      const {module, moduleKey} = moduleWeakMap.get(commit) || {};
      if (module) {
        const {_children} = module;
        const childrenKeys = Object.keys(_children);
        const descriptors = Object.getOwnPropertyDescriptors(state);
        const tag = hashTagMap.get(state) || USE_BLACK_TAG; // 默认黑名单
        const isWhiteTag = tag & USE_WHITE_TAG;
        const pureState = fromEntries(Object.entries(state).filter(([stateKey]) => {
          const {get: getter} = descriptors[stateKey] || {};
          return !childrenKeys.some(childKey => childKey === stateKey) 
            && !((isWhiteTag ^ descriptorSet.has(getter)));
        }));
        await storage.setItem(moduleKey, JSON.stringify(pureState));
      }

      return data;
    });
  };
  return descriptor;
};

export const createStatePlugin = (option = {}) => {
  const {key, intercept = registerInterceptor} = option;
  key && (rootKey = key);
  return function(store) {
    const init = getStateData(store._modules.root, [rootKey], true).then(savedState => {
      store.replaceState(merge(store.state, savedState, {
        arrayMerge: function (store, saved) { return saved },
        clone: false,
      }));
    }).catch(() => {});
    intercept(init);
  };
};

export const startApp = runInterceptor;