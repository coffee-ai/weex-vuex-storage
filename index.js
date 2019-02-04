import {Store} from 'vuex';
import fromEntries from 'object.fromentries';
import merge from 'deepmerge';
import {registerInterceptor, runInterceptor} from './src/intercept';

let rootKey = 'storage';

const storage = (() => {
  if (typeof weex !== 'undefined') {
    return new Proxy(
      weex.requireModule('storage'),
      {
        get: function(target, prop) {
          const fn = target[prop];
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

export const setState = (target, name, descriptor) => {
  const fn = descriptor.value;
  descriptor.value = function(...args) {
    const [{state, commit, getters}] = args;
    const oldValue = fn.apply(this, args);
    if (!isPromise(oldValue)) {
      throw new Error(`setState must decorate a promise function`);
    }
    return oldValue.then(async data => {
      // TODO 无法通过_modulesNamespaceMap获取namespaced为false的module，需改为遍历_children
      const rawModule = Object.entries(this._modulesNamespaceMap);
      const moduleMap = rawModule.find(([, module]) => {
        return module.context.commit === commit;
      });
      if (moduleMap) {
        const [key, {_children}] = moduleMap;
        const childrenKeys = Object.keys(_children);
        const pureState = fromEntries(Object.entries(state).filter(([stateKey]) => {
            return !childrenKeys.some(childKey => childKey === stateKey);
        }));
        await storage.setItem(`${rootKey}/${key}`, JSON.stringify(pureState));
      }
      return data;
    });
  };
  return descriptor;
}

export const createStatePlugin = (option = {}) => {
  const {key, intercept = registerInterceptor} = option;
  key && (rootKey = key);
  return (store) => {
    const getStateData = async function getModuleState(module, path = []) {
      const {_children} = module;
      const data = parseJSON(await storage.getItem(`${path.join('/')}/`)) || {};
      const children = Object.entries(_children);
      if (!children.length) {
        return data;
      }
      const childModules = await Promise.all(
        children.map(async ([childKey, child]) => {
          return [childKey, await getModuleState(child, path.concat(childKey))];
        })
      );
      return {
        ...data,
        ...fromEntries(childModules),
      }
    };
    const init = getStateData(store._modules.root, [rootKey]).then(savedState => {
      store.replaceState(merge(store.state, savedState, {
        arrayMerge: function (store, saved) { return saved },
        clone: false,
      }));
    }).catch(() => {});
    intercept(init);
  };
}

export const startApp = runInterceptor