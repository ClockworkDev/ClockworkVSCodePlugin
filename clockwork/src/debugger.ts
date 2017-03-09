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


function readManifest(path) {
	try {
		var manifest = require(path);
	} catch (e) {
		return null;
	}
	return manifest;
}


/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the program to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
}


class ClockworkDebugSession extends DebugSession {
	//Clockwork stuff
	private opn = require('opn');
	private isClientConnected = false;

	private io = require('socket.io')();

	private parsedBreakpoints: Array<ClockworkBreakPoint>;

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
		//Launch the app in the runtime
		var manifest = readManifest(args.program);
		this.opn("cwrt://localhost:" + this.serverPort + "/debug?app=" + manifest.name);

		// we just start to run until we hit a breakpoint or an exception
		this.continueRequest(<DebugProtocol.ContinueResponse>response, { threadId: ClockworkDebugSession.THREAD_ID });
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		var path = args.source.path;
		var clientLines = args.lines;
		// read file contents into array for direct access
		var lines = readFileSync(path).toString().split('\n');

		var breakpoints = new Array<Breakpoint>();

		var parser = new ClockworkParser(lines);

		// verify breakpoint locations
		for (var i = 0; i < clientLines.length; i++) {
			var l = this.convertClientLineToDebugger(clientLines[i]);
			var verified = false;
			if (l < lines.length) {
				const line = lines[l].trim();
				var { component, event, eventLine } = parser.getComponentEvent(l);
				l = eventLine;
				this.parsedBreakpoints.push(new ClockworkBreakPoint(eventLine, component, event, path));
			}
			const bp = <DebugProtocol.Breakpoint>new Breakpoint(true, this.convertDebuggerLineToClient(l));
			bp.id = this._breakpointId++;
			breakpoints.push(bp);
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

		response.body = {
			result: `evaluate(context: '${args.context}', '${args.expression}')`,
			variablesReference: 0
		};
		this.sendResponse(response);
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
	public constructor(lines) {
		this.lines = lines;
	}
	private getLineLength(n) {
		return this.lines[n].length;
	}
	private getCharAt(p: CursorPosition) {
		return this.lines[p.line][p.character];
	}
	public getComponentEvent(n: Number) {
		var p = new CursorPosition(n, this.getLineLength(n));
		var nextComponentStartsAfter = this.findPreviousInstanceOf(/CLOCKWORKRT.components.push/g, p);
		do {
			var componentStart = this.findNextInstanceOf(/{/g, nextComponentStartsAfter);
			var componentEnd = this.findMatchingPair("{", "}", componentStart);
			nextComponentStartsAfter = componentEnd;
		} while (p.line > componentEnd.line);
		var component;
		eval("component = " + this.substring(componentStart, componentEnd));
		var componentName = component.name;
		var nextEventStartsAfter = this.findJSproperty(componentStart, "events");
		do {
			var eventStart = this.findNextInstanceOf(/{/g, nextEventStartsAfter);
			var eventEnd = this.findMatchingPair("{", "}", eventStart);
			nextEventStartsAfter = eventEnd;
		} while (p.line > eventEnd.line);
		var event;
		eval("event = " + this.substring(eventStart, eventEnd));
		var eventName = event.name;
		var eventNamePosition = this.findJSproperty(eventStart, "name");
		return { component: componentName, event: eventName, eventLine: eventNamePosition.line };
	}
	private findParentEvent(p: CursorPosition): EventInfo {
		return new EventInfo("", 0);
	}

	private findPreviousInstanceOf(pattern, p: CursorPosition): CursorPosition {
		if (p.line < 0) {
			return null;
		} else {
			var result, lastIndex = null;
			var remainingLine = this.lines[p.line].substring(0, p.character - 1);
			while ((result = pattern.exec(remainingLine))) {
				lastIndex = result.index;
			}

			if (lastIndex != null) {
				return new CursorPosition(p.line, lastIndex);
			} else {
				return this.findPreviousInstanceOf(pattern, new CursorPosition(p.line - 1, this.getLineLength(p.line - 1) - 1));
			}
		}
	}
	private findNextInstanceOf(pattern, p: CursorPosition): CursorPosition {
		if (p.line >= this.lines.length) {
			return null;
		} else {
			var result, firstIndex = null;
			var remainingLine = this.lines[p.line].substring(p.character, this.getLineLength(p.line));
			while ((result = pattern.exec(remainingLine))) {
				firstIndex = result.index;
				break;
			}

			if (firstIndex != null) {
				return new CursorPosition(p.line, firstIndex);
			} else {
				return this.findNextInstanceOf(pattern, new CursorPosition(p.line + 1, 0));
			}
		}
	}
	private findMatchingPair(open, close, p: CursorPosition) {
		if (this.getCharAt(p) != open) {
			return null; //If this happens, you are not using me correctly dude
		}
		var depth = 1;
		var currentPosition = p.character + 1;
		for (var i = p.line; i < this.lines.length; i++) {
			while (currentPosition < this.getLineLength(i)) {
				var currentPos = new CursorPosition(i, currentPosition);
				switch (this.getCharAt(currentPos)) {
					case open:
						depth++;
						break;
					case close:
						depth--;
						if (depth == 0) {
							return currentPos;
						}
						break;
				}
				currentPosition++;
			}
			currentPosition = 0;
		}
		return null;//Not found!
	}

	private findJSproperty(p: CursorPosition, property) {
		var depth = 0;
		var currentPosition = p.character + 1;
		for (var i = p.line; i < this.lines.length; i++) {
			while (currentPosition < this.getLineLength(i)) {
				var currentPos = new CursorPosition(i, currentPosition);
				switch (this.getCharAt(currentPos)) {
					case "{":
						depth++;
						break;
					case "}":
						depth--;
						break;
					default:
						var remainingString = this.lines[i].substr(currentPosition);
						if (remainingString.indexOf(property) == 0 && depth == 0) {
							return currentPos;
						}
						break;
				}
				currentPosition++;
			}
			currentPosition = 0;
		}
		return null;//Not found!
	}

	private substring(start: CursorPosition, end: CursorPosition): string {
		var substring = this.lines.filter(function (x, i) {
			return i > start.line && i < end.line;
		}).join("\n");
		substring = this.lines[start.line].substring(start.character) + "\n" + substring + "\n" + this.lines[end.line].substring(0, end.character + 1);
		return substring
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