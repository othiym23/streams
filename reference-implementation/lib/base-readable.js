'use strict';

var assert = require('assert');
var Promise = require('es6-promise').Promise;

/*
 *
 * CONSTANTS
 *
 */
var CLOSED_RESOLVE   = '_closedPromise@resolve';
var CLOSED_REJECT    = '_closedPromise@reject';
var READABLE_RESOLVE = '_readablePromise@resolve';
var READABLE_REJECT  = '_readablePromise@reject';


function BaseReadableStream(callbacks) {
  var stream = this;

  if (!callbacks) callbacks = {};

  this._buffer   = [];
  this._state    = 'waiting';
  this._draining = false;
  this._pulling  = false;

  this._onStart = callbacks.start || function _onStart() {};
  this._onPull  = callbacks.pull  || function _onPull() {};
  this._onAbort = callbacks.abort || function _onAbort() {};

  this._storedError = undefined;

  this._readablePromise = new Promise(function (resolve, reject) {
    stream[READABLE_RESOLVE] = resolve;
    stream[READABLE_REJECT] = reject;
  });

  this._closedPromise = new Promise(function (resolve, reject) {
    stream[CLOSED_RESOLVE] = resolve;
    stream[CLOSED_REJECT]  = reject;
  });

  Object.defineProperty(this, 'state', {
    configurable : false,
    enumerable   : true,
    get          : function () { return stream._state; }
  });

  Object.defineProperty(this, 'closed', {
    configurable : false,
    enumerable   : true,
    get          : function () { return stream._closedPromise; }
  });

  this._startedPromise = Promise.cast(
    this._onStart(
      this._push.bind(this),
      this._close.bind(this),
      this._error.bind(this)
    )
  );

  this._startedPromise.catch(function error(e) { stream._error(e); });
}

BaseReadableStream.prototype._push = function _push(data) {
  if (this._state === 'waiting') {
    this._buffer.push(data);
    this._pulling = false;
    this[READABLE_RESOLVE](undefined);
    this._state = 'readable';

    return true;
  }
  else if (this._state === 'readable') {
    this._buffer.push(data);
    this._pulling = false;

    return true;
  }

  return false;
};

BaseReadableStream.prototype._close = function _close() {
  if (this._state === 'waiting') {
    this[READABLE_REJECT](new Error ('stream has already been completely read'));
    this[CLOSED_RESOLVE](undefined);
    this._state = 'closed';
  }
  else if (this._state === 'readable') {
    this._draining = true;
  }
};

BaseReadableStream.prototype._error = function _error(error) {
  var stream = this;

  if (this._state === 'waiting') {
    this._storedError = error;
    this[CLOSED_REJECT](error);
    this[READABLE_REJECT](error);
    this._state = 'errored';
  }
  else if (this._state === 'readable') {
    this._buffer.length = 0;
    this._storedError = error;
    // do this instead of using Promise.reject so accessors are correct
    this._readablePromise = new Promise(function (resolve, reject) {
      stream[READABLE_RESOLVE] = resolve;
      stream[READABLE_REJECT]  = reject;
    });
    this[READABLE_REJECT](error);
    this[CLOSED_REJECT](error);
    this._state = 'errored';
  }
};

BaseReadableStream.prototype._callPull = function _callPull() {
  var stream = this;
  if (this._pulling === true) return;

  this._startedPromise.then(function fulfilled() {
    stream._onPull(
      stream._push.bind(this),
      stream._close.bind(this),
      stream._error.bind(this)
    );
  });
};

BaseReadableStream.prototype.wait = function wait() {
  if (this._state === 'waiting') this._callPull();

  return this._readablePromise;
};

BaseReadableStream.prototype.read = function read() {
  var stream = this;

  switch(this._state) {
    case 'waiting':
      throw new Error('no data available (yet)');
    case 'readable':
      assert(this._buffer.length > 0, 'there must be data available to read');
      var data = this._buffer.shift();

      if (this._buffer.length < 1) {
        assert(this._draining === true || this._draining === false,
               'draining only has two possible states');
        if (this._draining === true) {
          this[CLOSED_RESOLVE](undefined);
          this._readablePromise = Promise.reject(new Error('all data already read'));
          this._state = 'closed';
        }
        else {
          this._state = 'waiting';
          this._readablePromise = new Promise(function (resolve, reject) {
            stream[READABLE_RESOLVE] = resolve;
            stream[READABLE_REJECT] = reject;
          });
          this._callPull();
        }
      }

      return data;
    case 'errored':
      throw this._storedError;
    case 'closed':
      throw new Error('stream has already been consumed');
    default:
      throw new Error('stream state ' + this._state + ' is invalid');
  }
};

BaseReadableStream.prototype.abort = function abort(reason) {
  if (this._state === 'waiting') {
    try {
      this._onAbort(reason);
    }
    catch (error) {
      this._error(error);
      return Promise.reject(error);
    }
    this[CLOSED_RESOLVE](undefined);
    this[READABLE_REJECT](reason);
    this._state = 'closed';
  }
  else if (this._state === 'readable') {
    try {
      this._onAbort(reason);
    }
    catch (error) {
      this._error(error);
      return Promise.reject(error);
    }
    this[CLOSED_RESOLVE](undefined);
    this._readablePromise = Promise.reject(reason);
    this._buffer.length = 0;
    this._state = 'closed';
  }

  return Promise.resolve(undefined);
};

BaseReadableStream.prototype.pipeTo = function pipeTo(dest, options) {
  if (!options) options = {};

  var close = true;
  if ('close' in options) close = options.close;
  close = Boolean(close);

  var stream = this;

  function closeDest() { if (close) dest.close(); }

  // ISSUE: should this be preventable via an option or via `options.close`?
  function abortDest(reason) { dest.abort(reason); }
  function abortSource(reason) { stream.abort(reason); }

  function pumpSource() {
    switch (stream.state) {
      case 'readable':
        dest.write(stream.read()).catch(abortSource);
        fillDest();
        break;
      case 'waiting':
        stream.wait().then(fillDest, abortDest);
        break;
      case 'closed':
        closeDest();
        break;
      default:
        abortDest();
    }
  }

  function fillDest() {
    switch (dest.state) {
      case 'writable':
        pumpSource();
        break;
      case 'waiting':
        dest.wait().then(fillDest, abortSource);
        break;
      default:
        abortSource();
    }
  }
  fillDest();

  return dest;
};

BaseReadableStream.prototype.pipeThrough = function pipeThrough(transform, options) {
  if (!transform) transform = {};
  if (!options) options = {close : true};

  assert(transform.in, 'input WritableStream required');
  assert(transform.out, 'output ReadableStream required');

  this.pipeTo(transform.in, options);
  return transform.out;
};

module.exports = BaseReadableStream;
