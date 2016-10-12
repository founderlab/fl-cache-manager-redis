'use strict';

var _classCallCheck = require('babel-runtime/helpers/class-call-check')['default'];

var _interopRequireDefault = require('babel-runtime/helpers/interop-require-default')['default'];

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _solRedisPool = require('sol-redis-pool');

var _solRedisPool2 = _interopRequireDefault(_solRedisPool);

var _events = require('events');

var _redisUrl = require('redis-url');

var _redisUrl2 = _interopRequireDefault(_redisUrl);

/**
 * The cache manager Redis Store module
 * @module redisStore
 * @param {Object} [options] - The store configuration (optional)
 * @param {String} options.host - The Redis server host
 * @param {Number} options.port - The Redis server port
 * @param {Number} options.db - The Redis server db
 * @param {Function} options.hashFromKey - If present, hashes will be generated from keys and values will be stored in the corresponding hash
 * @param {Function} options.isCacheableValue - to override built-in isCacheableValue (optional)
 */

var RedisStore = (function () {
  function RedisStore(options) {
    var _this = this,
        _arguments = arguments;

    _classCallCheck(this, RedisStore);

    this.connect = function (callback) {
      _this.pool.acquire(function (err, conn) {
        if (err) {
          _this.pool.release(conn);
          return callback(err);
        }

        if (_this.db || _this.db === 0) {
          conn.select(_this.db);
        }

        callback(null, conn);
      });
    };

    this.parse = function (values) {
      if (_lodash2['default'].isNull(values) || values === 'null') return null;
      if (_lodash2['default'].isDate(values)) return values;
      if (_lodash2['default'].isArray(values)) return _lodash2['default'].map(values, _this.parse);
      if (_lodash2['default'].isObject(values)) {
        var _ret = (function () {
          var result = {};
          _lodash2['default'].forEach(values, function (value, key) {
            result[key] = _this.parse(value);
          });
          return {
            v: result
          };
        })();

        if (typeof _ret === 'object') return _ret.v;
      } else if (_lodash2['default'].isString(values)) {
        try {
          // Date
          if (values.length >= 20 && values[values.length - 1] === 'Z') {
            var date = new Date(values);
            var isValidDate = date.getTime() !== 0 && !!date.getTime();
            if (isValidDate) return date;
            return values;
          }
          // Stringified JSON
          var parsedValues = JSON.parse(values);
          return _this.parse(parsedValues);
        } catch (err) {
          return values;
        }
      }
      return values;
    };

    this.handleResponse = function (conn, _options, _callback) {
      var _ref = typeof _options === 'function' ? { callback: _options, options: {} } : { callback: _callback, options: _options || {} };

      var callback = _ref.callback;
      var options = _ref.options;

      return function (err, _result) {
        _this.pool.release(conn);
        if (err) return callback(err);
        var result = _result;

        if (options.parse) {
          try {
            result = _this.parse(result);
          } catch (e) {
            return callback(e);
          }
        } else if (options.hashParse) {
          try {
            var resultContainer = _this.parse(result);
            if (!resultContainer) return callback(null, resultContainer);
            result = resultContainer.value;
            if (resultContainer._redis_set_at) {
              var now = new Date();
              var then = resultContainer._redis_set_at;
              var expired = now.getTime() - then.getTime() > resultContainer.ttl;
              if (expired) {
                return _this.hdel(options.hash, options.key, function (err) {
                  return callback && callback(err);
                });
              }
            }
          } catch (e) {
            return callback && callback(e);
          }
        }

        callback && callback(null, result);
      };
    };

    this.get = function (key, options, _callback) {
      var callback = typeof options === 'function' ? options : _callback;

      _this.connect(function (err, conn) {
        if (err) {
          return callback && callback(err);
        }

        // If we can get a hash from this key that's where we'll store the value
        // We need to manually set the expiry in this case, as there's no hsetex operation in redis
        if (_this.hashFromKey) {
          var hash = _this.hashFromKey(key);
          if (hash) {
            return conn.hget(hash, key, _this.handleResponse(conn, { hash: hash, key: key, hashParse: true }, callback));
          }
        }

        conn.get(key, _this.handleResponse(conn, { parse: true }, callback));
      });
    };

    this.set = function (key, value, _options, _callback) {
      var _ref2 = typeof _options === 'function' ? { callback: _options, options: {} } : { callback: _callback, options: _options || {} };

      var callback = _ref2.callback;
      var options = _ref2.options;

      if (!_this.isCacheableValue(value)) {
        return callback(new Error('value cannot be ' + value));
      }

      var ttl = options.ttl || options.ttl === 0 ? options.ttl : _this._ttl;

      _this.connect(function (err, conn) {
        if (err) {
          return callback && callback(err);
        }

        // If we can get a hash from this key that's where we'll store the value
        // We need to manually set the expiry in this case, as there's no hsetex operation in redis
        if (_this.hashFromKey) {
          var hash = _this.hashFromKey(key);
          if (hash) {
            var valueContainer = {
              ttl: ttl,
              value: value,
              _redis_set_at: new Date().toISOString()
            };
            return conn.hset(hash, key, JSON.stringify(valueContainer), _this.handleResponse(conn, callback));
          }
        }

        var val = JSON.stringify(value) || '"undefined"';
        if (ttl) {
          conn.setex(key, ttl, val, _this.handleResponse(conn, callback));
        } else {
          conn.set(key, val, _this.handleResponse(conn, callback));
        }
      });
    };

    this.del = function (key, _options, _callback) {
      var _ref3 = typeof _options === 'function' ? { callback: _options, options: {} } : { callback: _callback, options: _options || {} };

      var callback = _ref3.callback;
      var options = _ref3.options;

      if (_this.hashFromKey && !options.skipHashFromKey) {
        var hash = _this.hashFromKey(key);
        if (hash) {
          return _this.hdel(hash, key, options, callback);
        }
      }

      _this.connect(function (err, conn) {
        if (err) {
          return callback && callback(err);
        }
        conn.del(key, _this.handleResponse(conn, callback));
      });
    };

    this.hdel = function (hash, key, options, _callback) {
      var callback = typeof options === 'function' ? options : _callback;

      _this.connect(function (err, conn) {
        if (err) {
          return callback && callback(err);
        }
        conn.hdel(hash, key, _this.handleResponse(conn, callback));
      });
    };

    this.reset = function (callback) {
      _this.connect(function (err, conn) {
        if (err) {
          return callback && callback(err);
        }
        conn.flushdb(_this.handleResponse(conn, callback));
      });
    };

    this.hreset = function (hash, callback) {
      return _this.del(hash, { skipHashFromKey: true }, callback);
    };

    this.ttl = function (key, callback) {
      _this.connect(function (err, conn) {
        if (err) {
          return callback && callback(err);
        }
        conn.ttl(key, _this.handleResponse(conn, callback));
      });
    };

    this.keys = function (_pattern, _callback) {
      var _ref4 = typeof _pattern === 'function' ? { callback: _pattern, pattern: '*' } : { callback: _callback, pattern: _pattern };

      var callback = _ref4.callback;
      var pattern = _ref4.pattern;

      _this.connect(function (err, conn) {
        if (err) {
          return callback && callback(err);
        }
        conn.keys(pattern, _this.handleResponse(conn, callback));
      });
    };

    this.getClient = function (callback) {
      _this.connect(function (err, conn) {
        if (err) {
          return callback && callback(err);
        }
        callback(null, {
          client: conn,
          done: function done(_done) {
            var options = Array.prototype.slice.call(_arguments, 1);
            _this.pool.release(conn);

            if (_done && typeof _done === 'function') {
              _done.apply(null, options);
            }
          }
        });
      });
    };

    this.name = 'redis';
    this.events = new _events.EventEmitter();
    var redisOptions = this.getFromUrl(options) || options || {};
    var poolSettings = redisOptions;

    redisOptions.host = redisOptions.host || '127.0.0.1';
    redisOptions.port = redisOptions.port || 6379;
    this.pool = new _solRedisPool2['default'](redisOptions, poolSettings);

    this.pool.on('error', function (err) {
      _this.events.emit('redisError', err);
    });

    this._ttl = redisOptions.ttl;
    this.db = redisOptions.db;
    this.hashFromKey = options.hashFromKey;

    /**
     * Specify which values should and should not be cached.
     * If the returns true, it will be stored in cache.
     * By default, it caches everything except undefined values.
     * Can be overriden via standard node-cache-manager options.
     * @method isCacheableValue
     * @param {String} value - The value to check
     * @return {Boolean} - Returns true if the value is cacheable, otherwise false.
     */
    this.isCacheableValue = options.isCacheableValue || function (value) {
      return value !== undefined && value !== null;
    };
  }

  /**
   * Extracts options from an args.url
   * @param {Object} args
   * @param {String} args.url a string in format of redis://[:password@]host[:port][/db-number][?option=value]
   * @returns {Object} the input object args if it is falsy, does not contain url or url is not string, otherwise a new object with own properties of args
   * but with host, port, db, ttl and auth_pass properties overridden by those provided in args.url.
   */

  RedisStore.prototype.getFromUrl = function getFromUrl(args) {
    if (!args || typeof args.url !== 'string') {
      return args;
    }

    try {
      var options = _redisUrl2['default'].parse(args.url);
      var newArgs = _lodash2['default'].cloneDeep(args);
      newArgs.host = options.hostname;
      newArgs.port = parseInt(options.port, 10);
      newArgs.db = parseInt(options.database, 10);
      newArgs.auth_pass = options.password;
      newArgs.password = options.password;
      if (options.query && options.query.ttl) {
        newArgs.ttl = parseInt(options.query.ttl, 10);
      }
      return newArgs;
    } catch (e) {
      //url is unparsable so returning original
      return args;
    }
  };

  /**
   * Helper to connect to a connection pool
   * @private
   * @param {Function} callback - A callback that returns
   */
  return RedisStore;
})();

module.exports = {
  create: function create(options) {
    return new RedisStore(options);
  }
};

/**
 * Helper to handle callback and release the connection
 * @private
 * @param {Object} conn - The Redis connection
 * @param {Function} [callback] - A callback that returns a potential error and the result
 * @param {Object} [opts] - The options (optional)
 */

/**
 * Get a value for a given key.
 * @method get
 * @param {String} key - The cache key
 * @param {Object} [options] - The options (optional)
 * @param {Function} callback - A callback that returns a potential error and the response
 */

/**
 * Set a value for a given key.
 * @method set
 * @param {String} key - The cache key
 * @param {String} value - The value to set
 * @param {Object} [options] - The options (optional)
 * @param {Object} options.ttl - The ttl value
 * @param {Function} [callback] - A callback that returns a potential error, otherwise null
 */

/**
 * Delete value of a given key
 * @method del
 * @param {String} key - The cache key
 * @param {Object} [options] - The options (optional)
 * @param {Function} [callback] - A callback that returns a potential error, otherwise null
 */

/**
 * Delete value of a given key in a given hash
 * @method hdel
 * @param {String} hash - The hash key
 * @param {String} key - The cache key
 * @param {Object} [options] - The options (optional)
 * @param {Function} [callback] - A callback that returns a potential error, otherwise null
 */

/**
 * Delete all the keys of the currently selected DB
 * @method reset
 * @param {Function} [callback] - A callback that returns a potential error, otherwise null
 */

/**
 * Delete all the keys in the given hash
 * This is just sugar around del(hash=key, callback)
 * @method hreset
 * @param {Function} [callback] - A callback that returns a potential error, otherwise null
 */

/**
 * Returns the remaining time to live of a key that has a timeout.
 * @method ttl
 * @param {String} key - The cache key
 * @param {Function} callback - A callback that returns a potential error and the response
 */

/**
 * Returns all keys matching pattern.
 * @method keys
 * @param {String} pattern - The pattern used to match keys
 * @param {Function} callback - A callback that returns a potential error and the response
 */

/**
 * Returns the underlying redis client connection
 * @method getClient
 * @param {Function} callback - A callback that returns a potential error and an object containing the Redis client and a done method
 */