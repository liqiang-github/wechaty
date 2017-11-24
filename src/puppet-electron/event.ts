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
import {
  WatchdogFood,
}                 from 'watchdog'

import {
  log,
}                 from '../config'
import Contact    from '../contact'
import {
  Message,
  MediaMessage,
}                 from '../message'
import {
  ScanInfo,
}                 from '../puppet'

import Firer      from './firer'
import PuppetElectron  from './puppet-electron'
import {
  MsgType,
  MsgRawObj,
}                 from './schema'

/* tslint:disable:variable-name */
export const Event = {
  onDing,

  onLog,
  onLogin,
  onLogout,

  onMessage,
  onScan,
  onUnload,

}

function onDing(this: PuppetElectron, data): void {
  log.silly('PuppetElectronEvent', 'onDing(%s)', data)
  this.emit('watchdog', { data })
}

async function onScan(this: PuppetElectron, data: ScanInfo): Promise<void> {
  log.verbose('PuppetElectronEvent', 'onScan({code: %d, url: %s})', data.code, data.url)

  if (this.state.off()) {
    log.verbose('PuppetElectronEvent', 'onScan(%s) state.off()=%s, NOOP',
                                  data, this.state.off())
    return
  }

  this.scanInfo = data

  /**
   * When wx.qq.com push a new QRCode to Scan, there will be cookie updates(?)
   */
  await this.saveCookie()

  if (this.user) {
    log.verbose('PuppetElectronEvent', 'onScan() there has user when got a scan event. emit logout and set it to null')

    const bak = this.user || this.userId || ''
    this.user = this.userId = null
    this.emit('logout', bak)
  }

  // feed watchDog a `scan` type of food
  const food: WatchdogFood = {
    data,
    type: 'scan',
  }
  this.emit('watchdog', food)
  this.emit('scan'    , data.url, data.code)
}

function onLog(data: any): void {
  log.silly('PuppetElectronEvent', 'onLog(%s)', data)
}

async function onLogin(this: PuppetElectron, memo: string, ttl = 30): Promise<void> {
  log.verbose('PuppetElectronEvent', 'onLogin(%s, %d)', memo, ttl)

  const TTL_WAIT_MILLISECONDS = 1 * 1000
  if (ttl <= 0) {
    log.verbose('PuppetElectronEvent', 'onLogin(%s) TTL expired')
    this.emit('error', new Error('TTL expired.'))
    return
  }

  if (this.state.off()) {
    log.verbose('PuppetElectronEvent', 'onLogin(%s, %d) state.off()=%s, NOOP',
                                  memo, ttl, this.state.off())
    return
  }

  this.scanInfo = null

  if (this.userId) {
    log.warn('PuppetElectronEvent', 'onLogin(%s) userId had already set: "%s"', memo, this.userId)
  }

  try {
    /**
     * save login user id to this.userId
     *
     * issue #772: this.bridge might not inited if the 'login' event fired too fast(because of auto login)
     */
    this.userId = await this.bridge.getUserName()

    if (!this.userId) {
      log.verbose('PuppetElectronEvent', 'onLogin() browser not fully loaded(ttl=%d), retry later', ttl)
//      const html = await this.bridge.innerHTML()
//      log.silly('PuppetElectronEvent', 'onLogin() innerHTML: %s', html.substr(0, 500))
      setTimeout(onLogin.bind(this, memo, ttl - 1), TTL_WAIT_MILLISECONDS)
      return
    }

    log.silly('PuppetElectronEvent', 'bridge.getUserName: %s', this.userId)
    this.user = Contact.load(this.userId)
    await this.user.ready()
    log.silly('PuppetElectronEvent', `onLogin() user ${this.user.name()} logined`)

    try {
      if (this.state.on() === true) {
        await this.saveCookie()
      }
    } catch (e) { // fail safe
      log.verbose('PuppetElectronEvent', 'onLogin() this.saveCookie() exception: %s', e.message)
    }

    // fix issue #668
    try {
      await this.readyStable()
    } catch (e) { // fail safe
      log.warn('PuppetElectronEvent', 'readyStable() exception: %s', e && e.message || e)
    }

    this.emit('login', this.user)

  } catch (e) {
    log.error('PuppetElectronEvent', 'onLogin() exception: %s', e)
    throw e
  }

  return
}

function onLogout(this: PuppetElectron, data) {
  log.verbose('PuppetElectronEvent', 'onLogout(%s)', data)

  if (!this.user && !this.userId) {
    log.warn('PuppetElectronEvent', 'onLogout() without this.user or userId initialized')
  }

  const bak = this.user || this.userId || ''
  this.userId = this.user = null
  this.emit('logout', bak)
}

async function onMessage(
  this: PuppetElectron,
  obj: MsgRawObj,
): Promise<void> {
  let m = new Message(obj)

  try {
    await m.ready()

    /**
     * Fire Events if match message type & content
     */
    switch (m.type()) {

      case MsgType.VERIFYMSG:
        Firer.checkFriendRequest.call(this, m)
        break

      case MsgType.SYS:
        if (m.room()) {
          Firer.checkRoomJoin.call(this  , m)
          Firer.checkRoomLeave.call(this , m)
          Firer.checkRoomTopic.call(this , m)
        } else {
          Firer.checkFriendConfirm.call(this, m)
        }
        break
    }

    /**
     * Check Type for special Message
     * reload if needed
     */

    switch (m.type()) {
      case MsgType.EMOTICON:
      case MsgType.IMAGE:
      case MsgType.VIDEO:
      case MsgType.VOICE:
      case MsgType.MICROVIDEO:
      case MsgType.APP:
        log.verbose('PuppetElectronEvent', 'onMessage() EMOTICON/IMAGE/VIDEO/VOICE/MICROVIDEO message')
        m = new MediaMessage(obj)
        break

      case MsgType.TEXT:
        if (m.typeSub() === MsgType.LOCATION) {
          log.verbose('PuppetElectronEvent', 'onMessage() (TEXT&LOCATION) message')
          m = new MediaMessage(obj)
        }
        break
    }

    await m.ready()
    await m.from().ready()

    const to   = m.to()
    const room = m.room()
    if (to) {
      await to.ready()
    }
    if (room) {
      await room.ready()
    }

    this.emit('message', m)

  } catch (e) {
    log.error('PuppetElectronEvent', 'onMessage() exception: %s', e.stack)
    throw e
  }

  return
}

async function onUnload(this: PuppetElectron): Promise<void> {
  log.silly('PuppetElectronEvent', 'onUnload()')
  /*
  try {
    await this.quit()
    await this.init()
  } catch (e) {
    log.error('PuppetElectronEvent', 'onUnload() exception: %s', e)
    this.emit('error', e)
    throw e
  }
  */
}

export default Event