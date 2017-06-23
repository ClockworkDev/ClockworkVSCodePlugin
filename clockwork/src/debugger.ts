/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event, ContinuedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { readFileSync } from 'fs';
import { basename } from 'path';
const acorn = require('acorn');


function readManifest(path) {
	try {
		var manifest = require(path);
	} catch (e) {
		return null;
	}
	return manifest;
}


/**
 * This interface should always match the schema found in the debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the program to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	levelEditorEnabled?: boolean;
	remoteMachine?: string;
}


class ClockworkDebugSession extends DebugSession {
	//Clockwork stuff
	private opn = require('opn');
	private isClientConnected = false;

	private io = require('socket.io')();

	private parsedBreakpoints: Array<ClockworkBreakPoint>;
	private eventStepPoints: Array<ClockworkBreakPoint>;


	private objectVariables;
	private engineVariables;
	private eventStack;

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1000;

	// This is the next line that will be 'executed'
	private __currentLine = 0;
	private get _currentLine(): number {
		return this.__currentLine;
	}
	private set _currentLine(line: number) {
		this.__currentLine = line;
		this.log('line', line);
	}

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string;

	// the contents (= lines) of the one and only file
	private _sourceLines = new Array<string>();

	// maps from sourceFile to array of Breakpoints
	private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();


	private _variableHandles = new Handles<string>();

	private serverPort = 3001;

	private socketEmit;

	private evalId: number;
	private pendingEval;

	private isBackConnected;
	private isFrontConnected;
	private backendConnected() {
		if (!this.isBackConnected) {
			this.isBackConnected = true;
			if (this.isBackConnected && this.isFrontConnected) {
				this.sendEvent(new InitializedEvent());
			}
		}
	}

	private frontendConnected() {
		if (!this.isFrontConnected) {
			this.isFrontConnected = true;
			if (this.isBackConnected && this.isFrontConnected) {
				this.sendEvent(new InitializedEvent());
			}
		}
	}
	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super();

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this.isBackConnected = false;
		this.isFrontConnected = false;

		this.objectVariables = [];
		this.engineVariables = [];
		this.eventStack = [];

		var awaitingEvents = [];
		this.socketEmit = function (x, y) {
			awaitingEvents.push({ x: x, y: y })
		};

		this.pendingEval = [];
		this.evalId = 0;

		var session = this;
		this.io.on('connection', function (socket) {
			awaitingEvents.forEach((x, y) => socket.emit(x, y));
			session.socketEmit = function (x, y) {
				return socket.emit(x, y);
			}
			socket.on('breakpointHit', function (data) {
				session._sourceFile = data.bp.path;
				session._currentLine = data.bp.line;
				session.objectVariables = [];
				session.engineVariables = [];
				session.eventStack = data.stack;
				for (var id in data.vars) {
					session.objectVariables.push({ id: id, value: data.vars[id] });
				}
				for (var id in data.engineVars) {
					session.engineVariables.push({ id: id, value: data.engineVars[id] });
				}
				session.sendEvent(new StoppedEvent("step", ClockworkDebugSession.THREAD_ID));
			});
			socket.on('continue', function (data) {
				session.sendEvent(new ContinuedEvent(ClockworkDebugSession.THREAD_ID));
			});
			socket.on('exception', function (data) {
				const e = new OutputEvent(`ERROR: ${data.msg} \n`);
				session.sendEvent(e);
			});
			socket.on('log', function (data) {
				const e = new OutputEvent(`${data.msg} \n`);
				session.sendEvent(e);
			});
			socket.on('evalResult', function (data) {
				session.pendingEval[data.id](data.result);
			});
			session.backendConnected();
		});
		this.io.listen(this.serverPort);
		this.parsedBreakpoints = new Array<ClockworkBreakPoint>();
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.frontendConnected();

		// This debug adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = false;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		this.sendResponse(response);
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		this._sourceFile = args.program;
		this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		var manifest = readManifest(args.program);
		//Find all possible breakpoints

		this.eventStepPoints = manifest.components.map(function (x) {
			var path = args.program.replace("manifest.json", manifest.scope + "/" + x);
			var parser = new ClockworkParser(readFileSync(path).toString(), path);
			return parser.getPossibleBreakpointsFromFile();
		}).reduce(function (x, y) { return x.concat(y); });
		//Launch the app in the runtime
		if (args.remoteMachine) {
			var dgram = require('dgram');
			var server = dgram.createSocket("udp4");
			var serverPort = this.serverPort;
			server.bind(function () {
				server.setBroadcast(true)
				server.setMulticastTTL(128);
				var message = new Buffer("debug/" + serverPort + "/" + manifest.name + "/" + args.levelEditorEnabled);
				server.send(message, 0, message.length, 8775, args.remoteMachine);
			});
		} else {
			this.opn("cwrt://localhost:" + this.serverPort + "/debug?app=" + manifest.name + "&levelEditor=" + (args.levelEditorEnabled || true));
		}

		// we just start to run until we hit a breakpoint or an exception
		this.continueRequest(<DebugProtocol.ContinueResponse>response, { threadId: ClockworkDebugSession.THREAD_ID });
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		var path = args.source.path;
		var clientLines = args.lines;
		// read file contents into array for direct access
		var lines = readFileSync(path).toString().split('\n');

		var breakpoints = new Array<Breakpoint>();

		var parser = new ClockworkParser(readFileSync(path).toString(), path);

		// verify breakpoint locations
		for (var i = 0; i < clientLines.length; i++) {
			var l = this.convertClientLineToDebugger(clientLines[i]);
			const line = lines[l].trim();
			var cbp = parser.getComponentEvent(l);
			if (cbp) {
				l = cbp.line;
				this.parsedBreakpoints.push(cbp);
				const bp = <DebugProtocol.Breakpoint>new Breakpoint(true, this.convertDebuggerLineToClient(l));
				bp.id = this._breakpointId++;
				breakpoints.push(bp);
			}
		}
		this._breakPoints.set(path, breakpoints);

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: breakpoints
		};
		this.sendResponse(response);

		this.socketEmit('setBreakpoints', this.parsedBreakpoints);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// return the default thread
		response.body = {
			threads: [
				new Thread(ClockworkDebugSession.THREAD_ID, "Clockwork Engine Thread")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		var session = this;
		const frames = this.eventStack.map(function (event, i) {
			return new StackFrame(i, `${event.event} in ${event.component}`, new Source(session._sourceFile), session.convertDebuggerLineToClient(session._currentLine), 0);
		});
		response.body = {
			stackFrames: frames,
			totalFrames: 0
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Object variables", this._variableHandles.create("object"), false));
		scopes.push(new Scope("Engine variables", this._variableHandles.create("engine"), true));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		var variables;
		const id = this._variableHandles.get(args.variablesReference);
		if (id == "object") {
			variables = this.objectVariables.map(function (v, i) {
				return {
					name: v.id,
					type: typeof v.value,
					value: JSON.stringify(v.value),
					variablesReference: 0
				};
			});
		}
		if (id == "engine") {
			variables = this.engineVariables.map(function (v, i) {
				return {
					name: v.id,
					type: typeof v.value,
					value: JSON.stringify(v.value),
					variablesReference: 0
				};
			});
		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.socketEmit('continueRequest', '');

		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.socketEmit('stepOverRequest', '');
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.socketEmit('stepInRequest', '');
		this.sendResponse(response);
	}
	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.socketEmit('stepOutRequest', '');
		this.sendResponse(response);
	}


	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		var session = this;
		this.socketEmit('eval', { expression: args.expression, id: this.evalId });
		this.pendingEval[this.evalId] = function (result) {
			response.body = {
				result: result,
				variablesReference: 0
			};
			session.sendResponse(response);
		}
		this.evalId++;
	}

	//---- some helpers

	private log(msg: string, line: number) {
		const e = new OutputEvent(`${msg}: ${line}\n`);
		(<DebugProtocol.OutputEvent>e).body.variablesReference = this._variableHandles.create("args");
		this.sendEvent(e);	// print current line on debug console
	}
}

DebugSession.run(ClockworkDebugSession);

class ClockworkParser {
	private lines: String[];
	private path: String;
	private content: String;
	private ast;
	private possibleBreakpoints: Array<ClockworkBreakPoint>;

	public constructor(content, path) {
		var that = this;
		this.possibleBreakpoints = new Array<ClockworkBreakPoint>();
		this.content = content;
		this.path = path;
		this.ast = acorn.parse(content, { locations: true });
		that.ast.body.forEach(function (expression) {
			if (expression.type == "ExpressionStatement" && expression.expression.callee.property.name == "register" && expression.expression.callee.object.property.name == "components" && expression.expression.callee.object.object.name == "CLOCKWORKRT") {
				if (expression.expression.arguments[0].type == "ArrayExpression") {
					expression.expression.arguments[0].elements.forEach(function (component) {
						var currentComponentName = "";
						var currentEvents = [];
						component.properties.forEach(function (componentProperty) {
							if (componentProperty.key.name == "name") {
								currentComponentName = componentProperty.value.value;
							}
							if (componentProperty.key.name == "events") {
								componentProperty.value.elements.forEach(function (event) {
									var currentEventName = "";
									var currentEventPos = event.loc;
									event.properties.forEach(function (eventProperty) {
										if (eventProperty.key.name == "name") {
											currentEventName = eventProperty.value.value;
										}
									});
									currentEvents.push({ name: currentEventName, pos: currentEventPos });
								});
							}
						});
						currentEvents.forEach(function (event) {
							that.possibleBreakpoints.push(new ClockworkBreakPoint(event.pos.start.line, currentComponentName, event.name, path));
						});
					});
				}
			}
		});
	}
	public getPossibleBreakpointsFromFile(): Array<ClockworkBreakPoint> {
		return this.possibleBreakpoints;
	}

	public getComponentEvent(n: Number) {
		var currentBreakpoint = null;
		for (var i = 0; i < this.possibleBreakpoints.length; i++) {
			if (this.possibleBreakpoints[i].line > n) {
				break;
			} else {
				currentBreakpoint = this.possibleBreakpoints[i];
			}
		}
		return currentBreakpoint;
	}
}


class EventInfo {
	public event;
	public eventLine;
	public constructor(event: String, eventLine: Number) {
		this.event = event;
		this.eventLine = eventLine;
	}
}

class CursorPosition {
	public line;
	public character;
	public constructor(line: Number, character: Number) {
		this.line = line;
		this.character = character;
	}
	public afterThan(x: CursorPosition) {
		if (x.line == this.line) {
			return this.character > x.character;
		} else {
			return this.line > x.line;
		}
	}
	public beforeThan(x: CursorPosition) {
		if (x.line == this.line) {
			return this.character < x.character;
		} else {
			return this.line < x.line;
		}
	}
}

class ClockworkBreakPoint {
	public line;
	public component;
	public event;
	public path;
	public constructor(line: Number, component: String, event: String, path: String) {
		this.line = line;
		this.component = component;
		this.event = event;
		this.path = path;
	}
}

var CLOCKWORKRT = {
	components: {
		push: function (lx) {
			CLOCKWORKRT.actualComponents = CLOCKWORKRT.actualComponents.concat(lx);
		}
	},
	actualComponents: []
};
