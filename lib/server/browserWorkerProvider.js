var EventEmitter = require('events').EventEmitter,
	_ = require('underscore'),
	useragent = require("useragent"),
	generateId = require('node-uuid').v4,
	precondition = require('precondition');

var createWorker = require('./worker.js'),
	utils = require('./utils.js'),
	MESSAGE_TYPE = require('./protocol.js').WORKER_PROVIDER_MESSAGE_TYPE;

var create = module.exports = function(socket, options){
	var workerProvider = new BrowserWorkerProvider(socket);

	options = options || {};
	if(options.log) workerProvider.log = options.log;
	if(options.debug) workerProvider.debug = options.debug;
	if(options.spawnWorkerTimeout) workerProvider.spawnWorkerTimeout = options.spawnWorkerTimeout;
	
	return  workerProvider.api;
};

var BrowserWorkerProvider = function(socket){
	precondition.checkDefined(socket, "BrowserWorkerProvider requires a socket.");

	this.socket = socket;
	this.id = generateId();
	this.emitter = new EventEmitter();
	this.workerEmitters = {};
	this.pendingWorkers = {};
	this.workerCount = 0;
	this.available = true;

	socket.on('disconnect', this.kill.bind(this));
	socket.on('message', this.messageHandler.bind(this));

	Object.defineProperty(this, "api", { 
		value: Object.freeze(getApi.call(this)),
		enumerable: true 
	});
};

var getApi = function(){
	var self = this,
		api = this.getWorker.bind(this);
	
	api.on = this.emitter.on.bind(this.emitter);
	api.removeListener = this.emitter.removeListener.bind(this.emitter);
	api.id = this.id;
	api.toString = this.toString.bind(this);

	Object.defineProperty(api, "attributes", { 
		get: function(){ return self.attributes; },
		enumerable: true 
	});

	return api;
};

BrowserWorkerProvider.prototype.log = utils.noop;
BrowserWorkerProvider.prototype.debug = utils.noop;
BrowserWorkerProvider.prototype.spawnWorkerTimeout = 1000;

BrowserWorkerProvider.prototype.toString = function(){
	return this.attributes && this.attributes.name || "BrowserWorkerProvider";
};

BrowserWorkerProvider.prototype.sendToSocket = function(message){
	message = JSON.stringify(message);
	this.socket.send(message);
};

BrowserWorkerProvider.prototype.messageHandler = function(message){
	message = JSON.parse(message);

	switch(message[0]){
		case MESSAGE_TYPE['worker message']:
			this.workerMessageHandler(message[1], message[2]);
			return;
		case MESSAGE_TYPE['worker spawned']:
			this.spawnedWorkerHandler(message[1]);
			return;
		case MESSAGE_TYPE['worker dead']:
			this.workerDeadHandler(message[1]);
			return;
		case MESSAGE_TYPE['register']:
			this.registerHandler(message[1]);
			return;
		case MESSAGE_TYPE['available']:
			this.availableHandler();
			return;
		case MESSAGE_TYPE['unavailable']:
			this.unavailableHandler();
			return;
	}
};

BrowserWorkerProvider.prototype.availableHandler = function(){
	this.available = true;
	this.emitter.emit('available');
};

BrowserWorkerProvider.prototype.unavailableHandler = function(){
	this.available = false;
	this.emitter.emit('unavailable');
};

BrowserWorkerProvider.prototype.createWorker = function(workerId){
	var self = this,
		workerEmitter = new EventEmitter(),
		onSendToSocket = function(message){
			self.sendToSocket([
				MESSAGE_TYPE['worker message'],
				workerId,
				message
			]);
		},
		worker = createWorker(workerId, this.api, workerEmitter, onSendToSocket);

	this.workerEmitters[workerId] = workerEmitter;

	// Handle the case when a kill signal is sent from the server side
	worker.on("dead", function(){
		var workerEmitter = self.workerEmitters[workerId];
		if(workerEmitter !== void 0){
			self.sendToSocket([
				MESSAGE_TYPE['kill worker'],
				workerId
			]);

			self.removeWorker(workerId);
		}
	});

	this.emitter.emit("worker", worker);
	
	return worker;
};

BrowserWorkerProvider.prototype.spawnedWorkerHandler = function(workerId){
	var callback = this.pendingWorkers[workerId],
		worker;

	if(callback !== void 0){
		delete this.pendingWorkers[workerId];
		worker = this.createWorker(workerId);

		callback(worker);
	} else { // We weren't expecting this worker, send kill signal
		this.sendToSocket([
			MESSAGE_TYPE['kill worker'],
			workerId
		]);
	}
};

BrowserWorkerProvider.prototype.workerDeadHandler = function(workerId){
	var workerEmitter = this.workerEmitters[workerId];
	if(workerEmitter === void 0) return;
	workerEmitter.emit('dead');
};

BrowserWorkerProvider.prototype.registerHandler = function(attributes){
	var ua;
	
	attributes = attributes || {};
	
	if(attributes.userAgent){
		ua = useragent.parse(attributes.userAgent);
		attributes.name = ua.toAgent();
		attributes.family = ua.family;
		attributes.os = ua.os;
		attributes.version = {
			major: ua.major,
			minor: ua.minor,
			patch: ua.patch
		};
	}

	Object.freeze(attributes);

	this.attributes = attributes;

	this.emitter.emit('register', attributes);
};

BrowserWorkerProvider.prototype.kill = function(){
	var self = this;
	_.each(this.workerEmitters, function(workerEmitter, workerId){
		self.sendToSocket([
			MESSAGE_TYPE['kill worker'],
			workerId
		]);
		// Emulate the immediate death of the socket
		workerEmitter.emit('dead'); 
	});

	// Cancel all pending worker spawn requests
	_.each(this.pendingWorkers, function(callback, workerId){
		self.sendToSocket([
			MESSAGE_TYPE['kill worker'],
			workerId
		]);
		callback(void 0);
	});

	this.workerEmitters = {};
	this.emitter.emit('dead');
	this.emitter.removeAllListeners();
};

BrowserWorkerProvider.prototype.workerMessageHandler = function(workerId, workerMessage){
	var workerEmitter = this.workerEmitters[workerId];
	if(workerEmitter === void 0) return;
	workerEmitter.emit("message", workerMessage);
};

BrowserWorkerProvider.prototype.getWorker = function(workerConfig, callback){
	if(workerConfig === void 0) return;
	callback = callback || utils.noop;
	
	if(!this.available){
		callback(void 0);
		return;
	}

	var self = this,
		workerId = generateId();

	this.pendingWorkers[workerId] = callback;

	this.sendToSocket([
		MESSAGE_TYPE['spawn worker'],
		workerId,
		workerConfig
	]);
	
	// If the browser doesn't respond fast enough, emulate the killing of the worker
	setTimeout(function(){
		if(self.pendingWorkers[workerId] !== void 0){
			callback(void 0);
			self.debug('Spawn worker timed out');
			delete self.pendingWorkers[workerId];
			self.sendToSocket([
				MESSAGE_TYPE['kill worker'],
				workerId
			]);
		}
	}, this.spawnWorkerTimeout);
};

BrowserWorkerProvider.prototype.removeWorker = function(workerId){
	if(this.workerEmitters[workerId] === void 0) return;
	
	delete this.workerEmitters[workerId];
	this.emitter.emit("workerDead", workerId);
};