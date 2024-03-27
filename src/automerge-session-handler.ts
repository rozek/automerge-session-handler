/*******************************************************************************
*                                                                              *
*                        Automerge SessionHandler (ASH)                        *
*                                                                              *
*******************************************************************************/

  import {
    allowOrdinal,
    allowPlainObject, expectPlainObject,
    expectFunction,
  } from 'javascript-interface-library'

/**** Automerge "imports" will be defined later ****/

  let automerge:any, isValidAutomergeUrl:any, Repo:any      // will be set later
  let IndexedDBStorageAdapter:any                                        // dto.
  let BrowserWebSocketClientAdapter:any, BroadcastChannelNetworkAdapter:any

/**** ASH Types ****/

  export const ASH_SessionStates = [
    'unprepared','prepared','opening','open','closed','cancelled'
  ]
  export type ASH_SessionState = typeof ASH_SessionStates[number]

  export type ASH_URL = string                // mainly for illustrative reasons

  export type ASH_StateChangeHandler = (State:ASH_SessionState, Session:AutomergeSession) => void
  export type ASH_UpdateHandler      = (Event:any,              Session:AutomergeSession) => void
  export type ASH_BroadcastHandler   = (Message:Indexable,      Session:AutomergeSession) => void

  export type ASH_UpdateCallback = (Doc:any) => void

/**** plain Objects are treated as "Indexable" ****/

  interface Indexable { [Key:string]:any }

export class AutomergeSession {
  private _SessionState:ASH_SessionState = 'unprepared'
  private _CancellationReason:any

  private _StateChangeHandler:ASH_StateChangeHandler|undefined
  private _UpdateHandler:ASH_UpdateHandler|undefined
  private _BroadcastHandler:ASH_BroadcastHandler|undefined

  private _SessionRepo:any
  private _SessionURL:ASH_URL|undefined
  private _SessionDoc:any
  private _SessionDocHandle:any

  private _TimerId:any

/**** State ****/

  public get State ():ASH_SessionState  { return this._SessionState }
  public set State (_:ASH_SessionState) {
    throw new Error('ReadOnly: a session state can not be explicitly set')
  }

/**** CancellationReason ****/

  public get CancellationReason ():any  { return this._CancellationReason }
  public set CancellationReason (_:any) {
    throw new Error('ReadOnly: a cancellation reason can not be explicitly set')
  }

/**** URL ****/

  public get URL ():ASH_URL|undefined  { return this._SessionURL }
  public set URL (_:ASH_URL|undefined) {
    throw new Error('ReadOnly: a session URL can not be explicitly set')
  }

/**** isOpen ****/

  public get isOpen ():boolean  { return (this._SessionState === 'open') }
  public set isOpen (_:boolean) {
    throw new Error('ReadOnly: "isOpen" can not be explicitly set')
  }

/**** Doc ****/

  public get Doc ():any  { return this._SessionDoc }
  public set Doc (_:any) {
    throw new Error('ReadOnly: a session document can not be explicitly set')
  }

/**** DocHandle ****/

  public get DocHandle ():any  { return this._SessionDocHandle }
  public set DocHandle (_:any) {
    throw new Error('ReadOnly: a session document handle can not be explicitly set')
  }

/**** onStateChange ****/

  public onStateChange (Callback:ASH_StateChangeHandler):void {
    expectFunction('state change handler',Callback)
    this._StateChangeHandler = Callback
  }

/**** onUpdate ****/

  public onUpdate (Callback:ASH_UpdateHandler):void {
    expectFunction('document update handler',Callback)
    this._UpdateHandler = Callback
  }

/**** update ****/

  public update (Callback:ASH_UpdateCallback):void {
    expectFunction('document update callback',Callback)

    if (this._SessionState !== 'open') throw new Error(
      'InvalidState: session is not open, "' + this._SessionState + '"'
    )

    this._SessionDocHandle.change(Callback)
  }

/**** onBroadcast ****/

  public onBroadcast (Callback:ASH_BroadcastHandler):void {
    expectFunction('broadcast handler',Callback)
    this._BroadcastHandler = Callback
  }

/**** broadcast ****/

  public broadcast (Message:Indexable):void {
    expectPlainObject('broadcast message',Message)

    if (this._SessionState !== 'open') throw new Error(
      'InvalidState: session is not open, "' + this._SessionState + '"'
    )

    this._SessionDocHandle.broadcast(Message)
  }

/**** prepare ****/

  public prepare (Settings:Indexable):void {
    allowPlainObject('repository settings',Settings)

  /**** if need be: "import" Automerge, once ****/

    if (automerge == null) {
// @ts-ignore TS2339 allow "window.automerge"
      if (window.automerge == null) throw new Error(
        'InvalidState: "Automerge" has not yet been loaded'
      )

      ;({
        next:automerge, isValidAutomergeUrl, Repo,
        IndexedDBStorageAdapter,
        BrowserWebSocketClientAdapter, BroadcastChannelNetworkAdapter
// @ts-ignore TS2339 allow "window.automerge"
      } = window.automerge)
    }

    if (this._SessionState !== 'unprepared') throw new Error(
      'InvalidState: session was already prepared before'
    )

    if (Settings == null) {
      Settings = {
        network: [
          new BroadcastChannelNetworkAdapter(),
          new BrowserWebSocketClientAdapter('wss://sync.automerge.org')
        ],
        storage: new IndexedDBStorageAdapter(),
      }
    }

    this._SessionRepo = new Repo(Settings)

    this._changeSessionStateTo('prepared')
  }

/**** create ****/

  public create ():void {
    this.createAndLoad()                                       // keeps code DRY
  }

/**** createAndLoad ****/

  public createAndLoad (Schema?:Uint8Array):void {
    if ((Schema != null) && ! (Schema instanceof Uint8Array)) throw new Error(
      'InvalidArgument: the given "Schema" is not a byte array'
    )

    if (this._SessionState !== 'prepared') throw new Error(
      'InvalidState: session is not in state "prepared"'
    )

    this._SessionDocHandle = this._SessionRepo.create()
      if (Schema != null) {
        try {
          this._SessionDocHandle.change(
            (Doc:any) => automerge.merge(Doc,automerge.load(Schema))
          )
        } catch (Signal) {
          this.cancelDueTo('schema load error')
        }
      }
    this._SessionDoc = this._SessionDocHandle.docSync()
    this._SessionURL = this._SessionDocHandle.url

    this._changeSessionStateTo('open')
  }

/**** open ****/

  public async open (SessionURL:ASH_URL, Timeout:number):Promise<void> {
    if (! isValidAutomergeUrl(SessionURL)) throw new Error(
      'InvalidArgument: invalid Automerge URL given'
    )
    allowOrdinal('opening timeout [s]',Timeout)

    if (this._SessionState !== 'prepared') throw new Error(
      'InvalidState: session is not in state "prepared"'
    )

    this._SessionURL = SessionURL
    this._changeSessionStateTo('opening')

    this._SessionDocHandle = this._SessionRepo.find(SessionURL)
      if ((Timeout != null) && (Timeout > 0)) {
        this._TimerId = setTimeout(() => {
          if (this._SessionDocHandle.state !== 'ready') {
            this.cancelDueTo('opening timeout')
          }
        },Timeout*1000)
      }

      this._SessionDocHandle.whenReady([
        'deleted','unavailable','ready'
      ]).then(() => {
        if (this._TimerId != null) { clearTimeout(this._TimerId) }

        switch (true) {
          case this._SessionDocHandle.isDeleted():
            this.cancelDueTo('session deleted')
            return
          case this._SessionDocHandle.isUnavailable():
            this.cancelDueTo('session unavailable')
            return
          default:
            this._SessionDoc = this._SessionDocHandle.docSync()
            this._changeSessionStateTo('open')
        }

        this._SessionDocHandle.on('change',(Event:any) => {
          if (this._SessionState  !== 'open') { return }
          if (this._UpdateHandler !=  null)   { this._UpdateHandler(Event,this) }
        })

        this._SessionDocHandle.on('ephemeral-message',(Message:Indexable) => {
          if (this._SessionState     !== 'open') { return }
          if (this._BroadcastHandler !=  null)   { this._BroadcastHandler(Message,this) }
        })
      })
    return this._SessionDocHandle.whenReady()
  }

/**** close ****/

  public close ():void {
    switch (this._SessionState) {
      case 'open':      break
      case 'closed':
      case 'cancelled': return                          // "close" is idempotent
      default:
        throw new Error('InvalidState: session is not in state "open"')
    }

    if (this._TimerId != null) { clearTimeout(this._TimerId) }

    this._SessionDoc       = undefined
    this._SessionDocHandle = undefined
//  this_SessionURL        = undefined

    this._changeSessionStateTo('closed')
  }

/**** cancel ****/

  public cancel ():void {
    this.cancelDueTo('session cancelled')                      // keeps code DRY
  }

/**** cancelDueTo ****/

  public cancelDueTo (CancellationReason:any = 'session cancelled'):void {
    switch (this._SessionState) {
      case 'unprepared': case 'prepared':
      case 'opening':    case 'open':
        break
      case 'closed':
        throw new Error('InvalidState: session has already been closed')
      case 'cancelled':
        throw new Error('InvalidState: session has already been cancelled')
    }

    if (this._TimerId != null) { clearTimeout(this._TimerId) }

    this._SessionDoc       = undefined
    this._SessionDocHandle = undefined
//  this_SessionURL        = undefined

    this._CancellationReason = CancellationReason
    this._changeSessionStateTo('cancelled')
  }

/**** _changeSessionStateTo ****/

  private _changeSessionStateTo (SessionState:ASH_SessionState):void {
    this._SessionState = SessionState

    if (this._StateChangeHandler != null) {
      this._StateChangeHandler(SessionState,this)
    }
  }

}

