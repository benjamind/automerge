const { Map, List, fromJS } = require('immutable')
const uuid = require('./uuid')
const { rootObjectProxy } = require('./proxies')
const OpSet = require('./op_set')
const {isObject, checkTarget, makeChange, makeUndo, makeRedo, merge, applyChanges} = require('./auto_api')
const FreezeAPI = require('./freeze_api')
const ImmutableAPI = require('./immutable_api')
const { Text } = require('./text')
const transit = require('transit-immutable-js')

function makeOp(state, opProps, undoOps) {
  const opSet = state.get('opSet'), actor = state.get('actorId'), op = fromJS(opProps)
  if (undoOps) {
    undoOps = undoOps.map(op => op.remove('actor').remove('seq'))
  }
  let [opSet2, diff] = OpSet.addLocalOp(opSet, op, actor, undoOps)
  return state.set('opSet', opSet2)
}

function cachedContext() {
  return {
    cache: {},
    instantiateObject (opSet, objectId) {
      return opSet.getIn(['cache', objectId])
    }
  }
}

function insertAfter(state, listId, elemId) {
  if (!state.hasIn(['opSet', 'byObject', listId])) throw 'List object does not exist'
  if (!state.hasIn(['opSet', 'byObject', listId, elemId]) && elemId !== '_head') {
    throw 'Preceding list element does not exist'
  }
  const elem = state.getIn(['opSet', 'byObject', listId, '_maxElem'], 0) + 1
  state = makeOp(state, { action: 'ins', obj: listId, key: elemId, elem })
  return [state, state.get('actorId') + ':' + elem]
}

function createNestedObjects(state, value) {
  if (typeof value._objectId === 'string') return [state, value._objectId]
  const objectId = uuid()

  if (value instanceof Text) {
    state = makeOp(state, { action: 'makeText', obj: objectId })
    if (value.length > 0) throw 'assigning non-empty text is not yet supported'
  } else if (Array.isArray(value)) {
    state = makeOp(state, { action: 'makeList', obj: objectId })
    let elemId = '_head'
    for (let i = 0; i < value.length; i++) {
      [state, elemId] = insertAfter(state, objectId, elemId)
      state = setField(state, objectId, elemId, value[i], false)
    }
  } else {
    state = makeOp(state, { action: 'makeMap', obj: objectId })
    for (let key of Object.keys(value)) state = setField(state, objectId, key, value[key], false)
  }
  return [state, objectId]
}

function setField(state, objectId, key, value, topLevel) {
  if (typeof key !== 'string') {
    throw new TypeError('The key of a map entry must be a string, but ' +
                        JSON.stringify(key) + ' is a ' + (typeof key))
  }
  if (key === '') {
    throw new TypeError('The key of a map entry must not be an empty string')
  }
  if (key.startsWith('_')) {
    throw new TypeError('Map entries starting with underscore are not allowed: ' + key)
  }

  const fieldOps = OpSet.getFieldOps(state.get('opSet'), objectId, key)
  let undo
  if (topLevel) {
    undo = fieldOps.isEmpty() ? List.of(Map({action: 'del', obj: objectId, key: key})) : fieldOps
  }

  if (!['object', 'boolean', 'number', 'string'].includes(typeof value)) {
    throw new TypeError('Unsupported type of value: ' + (typeof value))
  } else if (isObject(value)) {
    const [newState, newId] = createNestedObjects(state, value)
    return makeOp(newState, { action: 'link', obj: objectId, key, value: newId }, undo)
  } else {
    // If the assigned field value is the same as the existing value, do nothing
    if (fieldOps.size === 1 && fieldOps.get(0).get('action') === 'set' &&
        fieldOps.get(0).get('value') === value) {
      return state
    } else {
      return makeOp(state, { action: 'set', obj: objectId, key, value }, undo)
    }
  }
}

function splice(state, objectId, start, deletions, insertions) {
  let elemIds = state.getIn(['opSet', 'byObject', objectId, '_elemIds'])
  for (let i = 0; i < deletions; i++) {
    let elemId = elemIds.keyOf(start)
    if (elemId) {
      const fieldOps = OpSet.getFieldOps(state.get('opSet'), objectId, elemId)
      state = makeOp(state, {action: 'del', obj: objectId, key: elemId}, fieldOps)
      elemIds = state.getIn(['opSet', 'byObject', objectId, '_elemIds'])
    }
  }

  // Apply insertions
  let prev = (start === 0) ? '_head' : elemIds.keyOf(start - 1)
  if (!prev && insertions.length > 0) {
    throw new RangeError('Cannot insert at index ' + start + ', which is past the end of the list')
  }
  for (let ins of insertions) {
    [state, prev] = insertAfter(state, objectId, prev)
    state = setField(state, objectId, prev, ins, true)
  }
  return state
}

function setListIndex(state, listId, index, value) {
  const elemIds = state.getIn(['opSet', 'byObject', listId, '_elemIds'])
  const elem = elemIds.keyOf(parseListIndex(index))
  if (elem) {
    return setField(state, listId, elem, value, true)
  } else {
    return splice(state, listId, index, 0, [value])
  }
}

function deleteField(state, objectId, key) {
  const objType = state.getIn(['opSet', 'byObject', objectId, '_init', 'action'])
  if (objType === 'makeList' || objType === 'makeText') {
    return splice(state, objectId, parseListIndex(key), 1, [])
  }

  const fieldOps = OpSet.getFieldOps(state.get('opSet'), objectId, key)
  if (fieldOps.isEmpty()) {
    return state
  } else {
    return makeOp(state, { action: 'del', obj: objectId, key: key }, fieldOps)
  }
}

///// Automerge.* API

function init(actorId) {
  return FreezeAPI.init(actorId || uuid())
}

function initImmutable(actorId) {
  return ImmutableAPI.init(actorId || uuid())
}

function parseListIndex(key) {
  if (typeof key === 'string' && /^[0-9]+$/.test(key)) key = parseInt(key)
  if (typeof key !== 'number')
    throw new TypeError('A list index must be a number, but you passed ' + JSON.stringify(key))
  if (key < 0 || isNaN(key) || key === Infinity || key === -Infinity)
    throw new RangeError('A list index must be positive, but you passed ' + key)
  return key
}

function change(doc, message, callback) {
  checkTarget('change', doc)
  if (doc._objectId !== '00000000-0000-0000-0000-000000000000') {
    throw new TypeError('The first argument to Automerge.change must be the document root')
  }
  if (doc._change && doc._change.mutable) {
    throw new TypeError('Calls to Automerge.change cannot be nested')
  }
  if (typeof message === 'function' && callback === undefined) {
    [message, callback] = [callback, message]
  }
  if (message !== undefined && typeof message !== 'string') {
    throw new TypeError('Change message must be a string')
  }

  const context = {state: doc._state, mutable: true, setField, splice, setListIndex, deleteField}
  callback(rootObjectProxy(context))

  // If the callback didn't change anything, return the original document object unchanged
  if (context.state.getIn(['opSet', 'local']).isEmpty()) {
    return doc
  } else {
    return makeChange(doc, context.state, message)
  }
}

function emptyChange(doc, message) {
  checkTarget('emptyChange', doc)
  if (message !== undefined && typeof message !== 'string') {
    throw new TypeError('Change message must be a string')
  }
  return makeChange(doc, doc._state, message)
}

function assign(target, values) {
  checkTarget('assign', target, true)
  if (!isObject(values)) throw new TypeError('The second argument to Automerge.assign must be an ' +
                                             'object, but you passed ' + JSON.stringify(values))
  let state = target._state
  for (let key of Object.keys(values)) {
    if (target._type === 'list') {
      state = setListIndex(state, target._objectId, key, values[key])
    } else {
      state = setField(state, target._objectId, key, values[key], true)
    }
  }
  target._change.state = state
}

function load(string, actorId) {
  const doc = FreezeAPI.init(actorId || uuid())
  const opset = doc._state.get('opSet')
  const changes = transit.fromJSON(string)
  return FreezeAPI.applyChanges(doc, opset, changes, false)
}

function loadImmutable(string, actorId) {
  const doc = ImmutableAPI.init(actorId || uuid())
  const opset = doc._state.get('opSet')
  const changes = transit.fromJSON(string)
  return ImmutableAPI.applyChanges(doc, opset, changes, false)
}

function save(doc) {
  checkTarget('save', doc)
  return transit.toJSON(doc._state.getIn(['opSet', 'history']))
}

function equals(val1, val2) {
  if (!isObject(val1) || !isObject(val2)) return val1 === val2
  const keys1 = Object.keys(val1).sort(), keys2 = Object.keys(val2).sort()
  if (keys1.length !== keys2.length) return false
  for (let i = 0; i < keys1.length; i++) {
    if (keys1[i] !== keys2[i]) return false
    if (!equals(val1[keys1[i]], val2[keys2[i]])) return false
  }
  return true
}

function inspect(doc) {
  checkTarget('inspect', doc)
  return JSON.parse(JSON.stringify(doc))
}

function getHistory(doc) {
  checkTarget('getHistory', doc)
  const history = doc._state.getIn(['opSet', 'history'])
  return history.map((change, index) => {
    return {
      get change () {
        return change.toJS()
      },
      get snapshot () {
        const root = FreezeAPI.init(doc._state.get('actorId'))
        const opset = root._state.get('opSet')
        return FreezeAPI.applyChanges(root, opset, history.slice(0, index + 1), false)
      }
    }
  }).toArray()
}

// Returns true if all components of clock1 are less than or equal to those of clock2.
// Returns false if there is at least one component in which clock1 is greater than clock2
// (that is, either clock1 is overall greater than clock2, or the clocks are incomparable).
function lessOrEqual(clock1, clock2) {
  return clock1.keySeq().concat(clock2.keySeq()).reduce(
    (result, key) => (result && clock1.get(key, 0) <= clock2.get(key, 0)),
    true)
}

function diff(oldState, newState) {
  checkTarget('diff', oldState)

  const oldClock = oldState._state.getIn(['opSet', 'clock'])
  const newClock = newState._state.getIn(['opSet', 'clock'])
  if (!lessOrEqual(oldClock, newClock)) {
    throw new RangeError('Cannot diff two states that have diverged')
  }

  let opSet = oldState._state.get('opSet').set('diff', List())
  const changes = OpSet.getMissingChanges(newState._state.get('opSet'), oldClock)

  let diffs = [], diff
  for (let change of changes) {
    [opSet, diff] = OpSet.addChange(opSet, change)
    diffs.push(...diff)
  }
  return diffs
}

function getConflicts(doc, list) {
  checkTarget('getConflicts', doc)
  const opSet = doc._state.get('opSet')
  const objectId = list._objectId
  if (!objectId || opSet.getIn(['byObject', objectId, '_init', 'action']) !== 'makeList') {
    throw new TypeError('The second argument to Automerge.getConflicts must be a list object')
  }
  return List(OpSet.listIterator(opSet, objectId, 'conflicts', cachedContext()))
}

function getChanges(oldState, newState) {
  checkTarget('getChanges', oldState)

  const oldClock = oldState._state.getIn(['opSet', 'clock'])
  const newClock = newState._state.getIn(['opSet', 'clock'])
  if (!lessOrEqual(oldClock, newClock)) {
    throw new RangeError('Cannot diff two states that have diverged')
  }

  return OpSet.getMissingChanges(newState._state.get('opSet'), oldClock).toJS()
}

function getChangesForActor(state, actorId) {
  checkTarget('getChanges', state)

  // I might want to validate the actorId here

  return OpSet.getChangesForActor(state._state.get('opSet'), actorId).toJS()
}

function getMissingDeps(doc) {
  checkTarget('getMissingDeps', doc)
  return OpSet.getMissingDeps(doc._state.get('opSet'))
}

function canUndo(doc) {
  checkTarget('canUndo', doc)
  return doc._state.getIn(['opSet', 'undoPos']) > 0
}

function undo(doc, message) {
  checkTarget('undo', doc)
  if (message !== undefined && typeof message !== 'string') {
    throw new TypeError('Change message must be a string')
  }
  return makeUndo(doc, message)
}

function canRedo(doc) {
  checkTarget('canRedo', doc)
  return !doc._state.getIn(['opSet', 'redoStack']).isEmpty()
}

function redo(doc, message) {
  checkTarget('redo', doc)
  if (message !== undefined && typeof message !== 'string') {
    throw new TypeError('Change message must be a string')
  }
  return makeRedo(doc, message)
}

module.exports = {
  init, change, emptyChange, merge, diff, assign, load, save, equals, inspect, getHistory,
  initImmutable, loadImmutable, getConflicts,
  getChanges, getChangesForActor, applyChanges, getMissingDeps, Text, uuid,
  getMissingChanges: OpSet.getMissingChanges,
  canUndo, undo, canRedo, redo,
  DocSet: require('./doc_set'),
  WatchableDoc: require('./watchable_doc'),
  Connection: require('./connection')
}
