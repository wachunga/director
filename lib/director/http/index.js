
var events = require('events'),
    qs = require('querystring'),
    util = require('util'),
    director = require('../../director'),
    responses = require('./responses');

//
// ### Expose all HTTP methods and responses
//
exports.methods   = require('./methods');
Object.keys(responses).forEach(function (name) {
  exports[name] = responses[name];
})

//
// ### function Router (routes)
// #### @routes {Object} **Optional** Routing table for this instance.
// Constuctor function for the HTTP Router object responsible for building 
// and dispatching from a given routing table.
//
var Router = exports.Router = function (routes) {
  //
  // ### Extend the `Router` prototype with all of the RFC methods.
  //
  this.params   = {};
  this.routes   = {};
  this.methods  = ['on', 'after', 'before'];
  this.scope    = [];
  this._methods = {};
  this.recurse = 'backward';
  
  this.extend(exports.methods.concat(['before', 'after']));
  this.configure();
  this.mount(routes || {});
};

//
// Inherit from `director.Router`.
//
util.inherits(Router, director.Router);

//
// ### function on (method, path, route)
// #### @method {string} **Optional** Method to use 
// #### @path {string} Path to set this route on.
// #### @route {Array|function} Handler for the specified method and path.
// Adds a new `route` to this instance for the specified `method`
// and `path`.
//
Router.prototype.on = function (method, path) {
  var args = Array.prototype.slice.call(arguments, 2),
      route = args.pop(),
      options = args.pop();
  
  if (options) {
    route.options = options;
    
    if (options['content-type'] && !Array.isArray(options['content-type'])) {
      options['content-type'] = [options['content-type']];
    }
  }
  
  director.Router.prototype.on.call(this, method, path, route);
};

//
// ### function dispatch (method, path)
// #### @req {http.ServerRequest} Incoming request to dispatch.
// #### @res {http.ServerResponse} Outgoing response to dispatch.
// #### @callback {function} **Optional** Continuation to respond to for async scenarios. 
// Finds a set of functions on the traversal towards
// `method` and `path` in the core routing table then 
// invokes them based on settings in this instance.
//
Router.prototype.dispatch = function (req, res, callback) {
  //
  // Dispatch `HEAD` requests to `GET`
  //  
  var method = req.method === 'HEAD' ? 'get' : req.method.toLowerCase(),
      fns = this.traverse(method, req.url, this.routes, ''),
      self = this,
      content,
      runlist,
      stream,
      err;
  
  if (!fns || fns.length === 0) {
    if (callback) {
      callback(new exports.NotFound('Could not find path: ' + req.url));
    }
    
    return false;
  }
  
  //
  // Change the order in which functions are invoked
  // if we are recursing forward.
  //
  if (this.recurse === 'forward') {
    fns = fns.reverse();
  }
  
  //
  // Create a runlist for these function
  //
  runlist = this.runlist(fns);
  
  content = runlist.some(function (fn) { 
    if (!fn.options || !fn.options['content-type']) {
      return true;
    }

    return fn.options['content-type'].some(function (header) { 
      header === req.headers['content-type'];
    });
  })
  
  if (!content) {
    err = new exports.BadRequest('Content-Type not allowed: ' + req.headers['content-type']);
    return callback ? callback(err) : err;
  }
  
  stream = fns.some(function (fn) { return fn.options && fn.options.stream === true });
  
  function parseAndInvoke() {
    self.parse(req);
    self.invoke(runlist, { req: req, res: res }, callback);
  }
  
  if (!stream) {
    //
    // If there is no streaming required on any of the functions on the 
    // way to `path`, then attempt to parse the fully buffered request stream
    // once it has emitted the `end` event.
    //
    if (req.readable) {
      //
      // If the `http.ServerRequest` is still readable, then await
      // the end event and then continue 
      //
      req.once('end', parseAndInvoke)
    }
    else {
      //
      // Otherwise, just parse the body now. 
      //
      parseAndInvoke();
    }
  }
  else {
    this.invoke(runlist, { req: req, res: res }, callback);
  }

  return true;
};

//
// ### @parsers {Object}
// Lookup table of parsers to use when attempting to 
// parse incoming responses.
//
Router.prototype.parsers = {
  'application/x-www-form-urlencoded': qs.parse,
  'application/json': JSON.parse
};

//
// ### function parse (req)
// #### @req {http.ServerResponse|BufferedStream} Incoming HTTP request to parse
// Attempts to parse `req.body` using the value found at `req.headers['content-type']`.
//
Router.prototype.parse = function (req) {
  function mime(req) {
    var str = req.headers['content-type'] || '';
    return str.split(';')[0];
  }
  
  var parser = this.parsers[mime(req)],
      body;
      
  if (parser) {
    req.body = req.body || '';
    
    if (req.chunks) {
      req.chunks.forEach(function (chunk) {
        req.body += chunk;
      });
    }
    
    try {
      req.body = req.body && req.body.length
        ? parser(req.body)
        : {};
    } 
    catch (err) {
      //
      // Remark: We should probably do something here.
      //
    }
  }
};

