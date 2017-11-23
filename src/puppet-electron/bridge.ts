/**
 *   Wechaty - https://github.com/chatie/wechaty
 *
 *   @copyright 2016-2017 Huan LI <zixia@zixia.net>
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */
import { EventEmitter } from 'events'
import * as fs          from 'fs'
import * as path        from 'path'

import {
    BrowserWindow,
    WebContents,
    Cookie,
    ipcMain
}                       from 'electron'

import StateSwitch      from 'state-switch'
import { parseString }  from 'xml2js'

const util = require('util')

/* tslint:disable:no-var-requires */
const retryPromise  = require('retry-promise').default

import { log }        from '../config'
import Profile        from '../profile'
import Misc           from '../misc'
import {
  MediaData,
  MsgRawObj,
}                     from './schema'

export interface InjectResult {
  code:    number,
  message: string,
}

export interface BridgeOptions {
  head?   : boolean,
  profile : Profile,
}

//declare const WechatyBro

export class Bridge extends EventEmitter {
  private browserWindow : BrowserWindow
  private page : WebContents
  private state   : StateSwitch

  constructor(
    public options: BridgeOptions,
  ) {
    super()
    log.verbose('PuppetElectronBridge', 'constructor()')

    this.state = new StateSwitch('PuppetElectronBridge', log)
  }

  public async init(): Promise<void> {
    log.verbose('PuppetElectronBridge', 'init()')

    this.state.on('pending')

    setTimeout(function(){ log.verbose("wait 3 seconds")},3000)
    try {
      await this.initBrowser()
      log.verbose('PuppetElectronBridge', 'init() initBrowser() done')

      this.on('load', this.onLoad.bind(this))

      const ready = new Promise(resolve => this.once('ready', resolve))
      await this.initPage(this.browserWindow)
      await ready

      this.state.on(true)
      log.verbose('PuppetElectronBridge', 'init() initPage() done')
    } catch (e) {
      log.error('PuppetElectronBridge', 'init() exception: %s', e)
      this.state.off(true)

      try {
        if (this.browserWindow) {
          await this.browserWindow.close()
        }
      } catch (e2) {
        log.error('PuppetElectronBridge', 'init() exception %s, close page/browser exception %s', e, e2)
      }

      this.emit('error', e)
      throw e
    }
  }

  public async initBrowser(): Promise<void> {
    log.verbose('PuppetElectronBridge', 'initBrowser()')
    this.browserWindow = new BrowserWindow({frame:false, webPreferences:{devTools:true}})
    ipcMain.on('ding',(event, args) => {
        log.verbose('ding', args)
        this.emit('ding', args)
    })
    ipcMain.on('log',(event, args) => {
        log.verbose('log', args)
        this.emit('log', args)
    })
    ipcMain.on('login',(event, args) => {
        log.verbose('login', args)
        this.emit('login', args)
    })
    ipcMain.on('logout',(event, args) => {
        log.verbose('logout', args)
        this.emit('logout', args)
    })
    ipcMain.on('message',(event, args) => {
        log.verbose('message', args)
        this.emit('message', args)
    })
    ipcMain.on('scan',(event, args) => {
        log.verbose('scan', args)
        this.emit('scan', args)
    })
    ipcMain.on('unload',(event, args) => {
        log.verbose('unload', args)
        this.emit('unload', args)
    })

  }

  public async onLoad(page: WebContents): Promise<void> {
    log.verbose('PuppetElectronBridge', 'initPage() on(load) %s', page.getURL())

    if (this.state.off()) {
      log.verbose('PuppetElectronBridge', 'initPage() onLoad() OFF state detected. NOP')
      return // reject(new Error('onLoad() OFF state detected'))
    }

    try {
      // const emitExist = await page.evaluate(() => {
      //   return typeof window['emit'] === 'function'
      // })
      // if (!emitExist) {
      //   await page.exposeFunction('emit', this.emit.bind(this))
      // }

      // await this.readyAngular(page)
      await this.inject(page)
      this.emit('ready')

    } catch (e) {
      log.error('PuppetElectronBridge', 'init() initPage() onLoad() exception: %s', e)
      this.emit('error', e)
    }
  }

  public async initPage(browserWindow: BrowserWindow): Promise<void> {
    log.verbose('PuppetElectronBridge', 'initPage()')
    browserWindow.loadURL('https://wx.qq.com')
    this.page = browserWindow.webContents

    await this.inject(this.page)
    this.emit('ready')
  }

  // public async readyAngular(page: WebContents): Promise<void> {
  //   log.verbose('PuppetElectronBridge', 'readyAngular()')
  //
  //   try {
  //     await page.waitForFunction(`typeof window.angular !== 'undefined'`)
  //   } catch (e) {
  //     log.verbose('PuppetElectronBridge', 'readyAngular() exception: %s', e)
  //
  //     const blockedMessage = await this.testBlockedMessage()
  //     if (blockedMessage) {  // Wechat Account Blocked
  //       throw new Error(blockedMessage)
  //     } else {
  //       throw e
  //     }
  //   }
  // }


  public async inject(page: WebContents): Promise<void> {
    log.verbose('PuppetElectronBridge', 'inject()')

    const WECHATY_BRO_JS_FILE = path.join(
      __dirname,
      'wechaty-bro.js',
    )

    try {
      const sourceCode = fs.readFileSync(WECHATY_BRO_JS_FILE)
                            .toString()

      let retObj = page.executeJavaScript(sourceCode) as any as InjectResult

      // if (retObj && /^(2|3)/.test(retObj.code.toString())) {
      //   // HTTP Code 2XX & 3XX
      //   log.silly('PuppetElectronBridge', 'inject() eval(Wechaty) return code[%d] message[%s]',
      //                                 retObj.code, retObj.message)
      // } else {  // HTTP Code 4XX & 5XX
      //   throw new Error('execute injectio error: ' + retObj.code + ', ' + retObj.message)
      // }

      retObj = await this.proxyWechaty('init')
      if (retObj && /^(2|3)/.test(retObj.code.toString())) {
        // HTTP Code 2XX & 3XX
        log.silly('PuppetElectronBridge', 'inject() Wechaty.init() return code[%d] message[%s]',
                                      retObj.code, retObj.message)
      } else {  // HTTP Code 4XX & 5XX
        throw new Error('execute proxyWechaty(init) error: ' + retObj.code + ', ' + retObj.message)
      }

      const SUCCESS_CIPHER = 'ding() OK!'
      const r = await this.ding(SUCCESS_CIPHER)
      if (r !== SUCCESS_CIPHER) {
        throw new Error('fail to get right return from call ding()')
      }
      log.silly('PuppetElectronBridge', 'inject() ding success')

    } catch (e) {
      log.verbose('PuppetElectronBridge', 'inject() exception: %s. stack: %s', e.message, e.stack)
      throw e
    }
  }

  public async logout(): Promise<any> {
    log.verbose('PuppetElectronBridge', 'logout()')
    try {
      return await this.proxyWechaty('logout')
    } catch (e) {
      log.error('PuppetElectronBridge', 'logout() exception: %s', e.message)
      throw e
    }
  }

  public quit() {
    log.verbose('PuppetElectronBridge', 'quit()')
    this.state.off('pending')

    try {
      this.browserWindow.close()
      log.silly('PuppetElectronBridge', 'quit() browser.close()-ed')
    } catch (e) {
      log.warn('PuppetElectronBridge', 'quit() browser.close() exception: %s', e)
    }

    this.state.off(true)
  }

  public async getUserName(): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getUserName()')

    try {
      const userName = await this.proxyWechaty('getUserName')
      return userName
    } catch (e) {
      log.error('PuppetElectronBridge', 'getUserName() exception: %s', e.message)
      throw e
    }
  }

  public async contactRemark(contactId: string, remark: string|null): Promise<boolean> {
    try {
      return await this.proxyWechaty('contactRemark', contactId, remark)
    } catch (e) {
      log.verbose('PuppetElectronBridge', 'contactRemark() exception: %s', e.message)
      // Issue #509 return false instead of throw when contact is not a friend.
      // throw e
      log.warn('PuppetElectronBridge', 'contactRemark() does not work on contact is not a friend')
      return false
    }
  }

  public async contactFind(filterFunc: string): Promise<string[]> {
    try {
      return await this.proxyWechaty('contactFind', filterFunc)
    } catch (e) {
      log.error('PuppetElectronBridge', 'contactFind() exception: %s', e.message)
      throw e
    }
  }

  public async roomFind(filterFunc: string): Promise<string[]> {
    try {
      return await this.proxyWechaty('roomFind', filterFunc)
    } catch (e) {
      log.error('PuppetElectronBridge', 'roomFind() exception: %s', e.message)
      throw e
    }
  }

  public async roomDelMember(roomId, contactId): Promise<number> {
    if (!roomId || !contactId) {
      throw new Error('no roomId or contactId')
    }
    try {
      return await this.proxyWechaty('roomDelMember', roomId, contactId)
    } catch (e) {
      log.error('PuppetElectronBridge', 'roomDelMember(%s, %s) exception: %s', roomId, contactId, e.message)
      throw e
    }
  }

  public async roomAddMember(roomId, contactId): Promise<number> {
    log.verbose('PuppetElectronBridge', 'roomAddMember(%s, %s)', roomId, contactId)

    if (!roomId || !contactId) {
      throw new Error('no roomId or contactId')
    }
    try {
      return await this.proxyWechaty('roomAddMember', roomId, contactId)
    } catch (e) {
      log.error('PuppetElectronBridge', 'roomAddMember(%s, %s) exception: %s', roomId, contactId, e.message)
      throw e
    }
  }

  public async roomModTopic(roomId, topic): Promise<string> {
    if (!roomId) {
      throw new Error('no roomId')
    }
    try {
      await this.proxyWechaty('roomModTopic', roomId, topic)
      return topic
    } catch (e) {
      log.error('PuppetElectronBridge', 'roomModTopic(%s, %s) exception: %s', roomId, topic, e.message)
      throw e
    }
  }

  public async roomCreate(contactIdList: string[], topic?: string): Promise<string> {
    if (!contactIdList || !Array.isArray(contactIdList)) {
      throw new Error('no valid contactIdList')
    }

    try {
      const roomId = await this.proxyWechaty('roomCreate', contactIdList, topic)
      if (typeof roomId === 'object') {
        // It is a Error Object send back by callback in browser(WechatyBro)
        throw roomId
      }
      return roomId
    } catch (e) {
      log.error('PuppetElectronBridge', 'roomCreate(%s) exception: %s', contactIdList, e.message)
      throw e
    }
  }

  public async verifyUserRequest(contactId, hello): Promise<boolean> {
    log.verbose('PuppetElectronBridge', 'verifyUserRequest(%s, %s)', contactId, hello)

    if (!contactId) {
      throw new Error('no valid contactId')
    }
    try {
      return await this.proxyWechaty('verifyUserRequest', contactId, hello)
    } catch (e) {
      log.error('PuppetElectronBridge', 'verifyUserRequest(%s, %s) exception: %s', contactId, hello, e.message)
      throw e
    }
  }

  public async verifyUserOk(contactId, ticket): Promise<boolean> {
    log.verbose('PuppetElectronBridge', 'verifyUserOk(%s, %s)', contactId, ticket)

    if (!contactId || !ticket) {
      throw new Error('no valid contactId or ticket')
    }
    try {
      return await this.proxyWechaty('verifyUserOk', contactId, ticket)
    } catch (e) {
      log.error('PuppetElectronBridge', 'verifyUserOk(%s, %s) exception: %s', contactId, ticket, e.message)
      throw e
    }
  }

  public async send(toUserName: string, content: string): Promise<boolean> {
    if (!toUserName) {
      throw new Error('UserName not found')
    }
    if (!content) {
      throw new Error('cannot say nothing')
    }

    try {
      return await this.proxyWechaty('send', toUserName, content)
    } catch (e) {
      log.error('PuppetElectronBridge', 'send() exception: %s', e.message)
      throw e
    }
  }

  public async getMsgImg(id): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getMsgImg(%s)', id)

    try {
      return await this.proxyWechaty('getMsgImg', id)
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getMsgImg, %d) exception: %s', id, e.message)
      throw e
    }
  }

  public async getMsgEmoticon(id): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getMsgEmoticon(%s)', id)

    try {
      return await this.proxyWechaty('getMsgEmoticon', id)
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getMsgEmoticon, %d) exception: %s', id, e.message)
      throw e
    }
  }

  public async getMsgVideo(id): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getMsgVideo(%s)', id)

    try {
      return await this.proxyWechaty('getMsgVideo', id)
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getMsgVideo, %d) exception: %s', id, e.message)
      throw e
    }
  }

  public async getMsgVoice(id): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getMsgVoice(%s)', id)

    try {
      return await this.proxyWechaty('getMsgVoice', id)
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getMsgVoice, %d) exception: %s', id, e.message)
      throw e
    }
  }

  public async getMsgPublicLinkImg(id): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getMsgPublicLinkImg(%s)', id)

    try {
      return await this.proxyWechaty('getMsgPublicLinkImg', id)
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getMsgPublicLinkImg, %d) exception: %s', id, e.message)
      throw e
    }
  }

  public async getContact(id: string): Promise<object> {
    if (id !== id) { // NaN
      const err = new Error('NaN! where does it come from?')
      log.error('PuppetElectronBridge', 'getContact(NaN): %s', err)
      throw err
    }
    const max = 35
    const backoff = 500

    // max = (2*totalTime/backoff) ^ (1/2)
    // timeout = 11,250 for {max: 15, backoff: 100}
    // timeout = 45,000 for {max: 30, backoff: 100}
    // timeout = 30,6250 for {max: 35, backoff: 500}
    const timeout = max * (backoff * max) / 2

    try {
      return await retryPromise({ max: max, backoff: backoff }, async attempt => {
        log.silly('PuppetElectronBridge', 'getContact() retryPromise: attampt %s/%s time for timeout %s',
                                      attempt, max, timeout)
        try {
          const r = await this.proxyWechaty('getContact', id)
          if (r) {
            return r
          }
          throw new Error('got empty return value at attempt: ' + attempt)
        } catch (e) {
          log.silly('PuppetElectronBridge', 'proxyWechaty(getContact, %s) exception: %s', id, e.message)
          throw e
        }
      })
    } catch (e) {
      log.warn('PuppetElectronBridge', 'retryPromise() getContact() finally FAIL: %s', e.message)
      throw e
    }
    /////////////////////////////////
  }

  public async getBaseRequest(): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getBaseRequest()')

    try {
      return await this.proxyWechaty('getBaseRequest')
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getBaseRequest) exception: %s', e.message)
      throw e
    }
  }

  public async getPassticket(): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getPassticket()')

    try {
      return await this.proxyWechaty('getPassticket')
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getPassticket) exception: %s', e.message)
      throw e
    }
  }

  public async getCheckUploadUrl(): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getCheckUploadUrl()')

    try {
      return await this.proxyWechaty('getCheckUploadUrl')
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getCheckUploadUrl) exception: %s', e.message)
      throw e
    }
  }

  public async getUploadMediaUrl(): Promise<string> {
    log.verbose('PuppetElectronBridge', 'getUploadMediaUrl()')

    try {
      return await this.proxyWechaty('getUploadMediaUrl')
    } catch (e) {
      log.silly('PuppetElectronBridge', 'proxyWechaty(getUploadMediaUrl) exception: %s', e.message)
      throw e
    }
  }

  public async sendMedia(mediaData: MediaData): Promise<boolean> {
    if (!mediaData.ToUserName) {
      throw new Error('UserName not found')
    }
    if (!mediaData.MediaId) {
      throw new Error('cannot say nothing')
    }
    try {
      return await this.proxyWechaty('sendMedia', mediaData)
    } catch (e) {
      log.error('PuppetElectronBridge', 'sendMedia() exception: %s', e.message)
      throw e
    }
  }

  public async forward(baseData: MsgRawObj, patchData: MsgRawObj): Promise<boolean> {
    if (!baseData.ToUserName) {
      throw new Error('UserName not found')
    }
    if (!patchData.MMActualContent && !patchData.MMSendContent && !patchData.Content) {
      throw new Error('cannot say nothing')
    }
    try {
      return await this.proxyWechaty('forward', baseData, patchData)
    } catch (e) {
      log.error('PuppetElectronBridge', 'forward() exception: %s', e.message)
      throw e
    }
  }

  /**
   * Proxy Call to Wechaty in Bridge
   */
  public async proxyWechaty(
    wechatyFunc : string,
    ...args     : any[],
  ): Promise<any> {
    log.silly('PuppetElectronBridge', 'proxyWechaty(%s%s)',
                                  wechatyFunc,
                                  args.length
                                  ? ' , ' + args.join(', ')
                                  : '',
              )

    try {
      const noWechaty = await this.page.executeJavaScript(`() => {
        return typeof WechatyBro === 'undefined'
    }`)
      if (noWechaty) {
        const e = new Error('there is no WechatyBro in browser(yet)')
        throw e
      }
    } catch (e) {
      log.warn('PuppetElectronBridge', 'proxyWechaty() noWechaty exception: %s', e)
      throw e
    }

    const argsEncoded = new Buffer(
      encodeURIComponent(
        JSON.stringify(args),
      ),
    ).toString('base64')
    // see: http://blog.sqrtthree.com/2015/08/29/utf8-to-b64/
    const argsDecoded = `JSON.parse(decodeURIComponent(window.atob('${argsEncoded}')))`

    const wechatyScript = `
      WechatyBro
        .${wechatyFunc}
        .apply(
          undefined,
          ${argsDecoded},
        )
    `.replace(/[\n\s]+/, ' ')
    // log.silly('PuppetElectronBridge', 'proxyWechaty(%s, ...args) %s', wechatyFunc, wechatyScript)
    // console.log('proxyWechaty wechatyFunc args[0]: ')
    // console.log(args[0])

    try {
      const ret = await this.page.executeJavaScript(wechatyScript)
      return ret
    } catch (e) {
      log.verbose('PuppetElectronBridge', 'proxyWechaty(%s, %s) ', wechatyFunc, args.join(', '))
      log.warn('PuppetElectronBridge', 'proxyWechaty() exception: %s', e.message)
      throw e
    }
  }

  public async ding(data): Promise<any> {
    log.verbose('PuppetElectronBridge', 'ding(%s)', data)

    try {
      return await this.proxyWechaty('ding', data)
    } catch (e) {
      log.error('PuppetElectronBridge', 'ding(%s) exception: %s', data, e.message)
      throw e
    }
  }

  public preHtmlToXml(text: string): string {
    log.verbose('PuppetElectronBridge', 'preHtmlToXml()')

    const preRegex = /^<pre[^>]*>([^<]+)<\/pre>$/i
    const matches = text.match(preRegex)
    if (!matches) {
      return text
    }
    return Misc.unescapeHtml(matches[1])
  }

  public async innerHTML(): Promise<string> {
    const html = await this.evaluate(() => {
      return document.body.innerHTML
    })
    return html
  }

  /**
   * Throw if there's a blocked message
   */
  public async testBlockedMessage(text?: string): Promise<string | false> {
    if (!text) {
      text = await this.innerHTML()
    }
    if (!text) {
      throw new Error('testBlockedMessage() no text found!')
    }

    const textSnip = text.substr(0, 50).replace(/\n/, '')
    log.verbose('PuppetElectronBridge', 'testBlockedMessage(%s)',
                                  textSnip)

    // see unit test for detail
    const tryXmlText = this.preHtmlToXml(text)

    interface BlockedMessage {
      error?: {
        ret     : number,
        message : string,
      }
    }

    return new Promise<string | false>((resolve, reject) => {
      parseString(tryXmlText, { explicitArray: false }, (err, obj: BlockedMessage) => {
        if (err) {  // HTML can not be parsed to JSON
          return resolve(false)
        }
        if (!obj) {
          // FIXME: when will this happen?
          log.warn('PuppetElectronBridge', 'testBlockedMessage() parseString(%s) return empty obj', textSnip)
          return resolve(false)
        }
        if (!obj.error) {
          return resolve(false)
        }
        const ret     = +obj.error.ret
        const message =  obj.error.message

        log.warn('PuppetElectronBridge', 'testBlockedMessage() error.ret=%s', ret)

        if (ret === 1203) {
          // <error>
          // <ret>1203</ret>
          // <message>当前登录环境异常。为了你的帐号安全，暂时不能登录web微信。你可以通过手机客户端或者windows微信登录。</message>
          // </error>
          return resolve(message)
        }
        return resolve(message) // other error message
      })
    })
  }

  public async hostname(): Promise<string | null> {
    log.verbose('PuppetElectronBridge', 'hostname()')
    try {
      const hostname = await this.page.executeJavaScript('() => location.hostname') as any as string
      log.silly('PuppetElectronBridge', 'hostname() got %s', hostname)
      return hostname
    } catch (e) {
      log.error('PuppetElectronBridge', 'hostname() exception: %s', e)
      this.emit('error', e)
      return null
    }
  }

  public async cookies(cookieList: Cookie[]): Promise<void>
  public async cookies(): Promise<Cookie[]>

  public async cookies(cookieList?: Cookie[]): Promise<void | Cookie[]> {
    if (cookieList) {
      try {
          cookieList.forEach(function(cookie) {
              this.page.session.cookies.set(cookie)
          })
      } catch (e) {
        log.error('PuppetWebBridge', 'cookies(%s) reject: %s', cookieList, e)
        this.emit('error', e)
      }
      return
    } else {
      const getcookie = util.promisify(this.page.session.cookies.get);
      cookieList = await getcookie()
      return cookieList
    }
  }


  public async reload(): Promise<void> {
    log.verbose('PuppetElectronBridge', 'reload()')
    await this.page.reload()
    return
  }

  public async evaluate(fn: () => any, ...args: any[]): Promise<any> {
      log.verbose('PuppetElectronBridge', 'evaluate()')
      //TODO to be implemented
    // log.silly('PuppetElectronBridge', 'evaluate()')
    // try {
    //   return await this.page.executeJavaScript(fn, ...args)
    // } catch (e) {
    //   log.error('PuppetElectronBridge', 'evaluate() exception: %s', e)
    //   this.emit('error', e)
    //   return null
    // }
  }
}

export {
  Cookie,
}

export default Bridge
