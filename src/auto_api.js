const { Map, List, fromJS } = require('immutable')
const OpSet = require('./op_set')
const FreezeAPI = require('./freeze_api')
const ImmutableAPI = require('./immutable_api')

function isObject(obj) {
  return typeof obj === 'object' && obj !== null
}

// TODO when we move to Immutable.js 4.0.0, this function is provided by Immutable.js itself
function isImmutable(obj) {
  return isObject(obj) && !!obj['@@__IMMUTABLE_ITERABLE__@@']
}

function checkTarget(funcName, target, needMutable) {
  if (!target || !target._state || !target._objectId ||
      !target._state.hasIn(['opSet', 'byObject', target._objectId])) {
    throw new TypeError('The first argument to Automerge.' + funcName +
                        ' must be the object to modify, but you passed ' + JSON.stringify(target))
  }
  if (needMutable && (!target._change || !target._change.mutable)) {
    throw new TypeError('Automerge.' + funcName + ' requires a writable object as first argument, ' +
                        'but the one you passed is read-only. Please use Automerge.change() ' +
                        'to get a writable version.')
  }
}

function applyNewChange(root, opSet, ops, message) {
  const actor = root._state.get('actorId')
  const seq = root._state.getIn(['opSet', 'clock', actor], 0) + 1
  const deps = root._state.getIn(['opSet', 'deps']).remove(actor)
  const change = List.of(Map({actor, seq, deps, message, ops}))

  if (isImmutable(root)) {
    return ImmutableAPI.applyChanges(root, opSet, change, true)
  } else {
    return FreezeAPI.applyChanges(root, opSet, change, true)
  }
}

function makeChange(root, newState, message) {
  // If there are multiple assignment operations for the same object and key,
  // keep only the most recent
  let assignments = Map()
  const ops = List().withMutations(ops => {
    for (let op of newState.getIn(['opSet', 'local']).reverse()) {
      if (['set', 'del', 'link'].includes(op.get('action'))) {
        if (!assignments.getIn([op.get('obj'), op.get('key')])) {
          assignments = assignments.setIn([op.get('obj'), op.get('key')], true)
          ops.unshift(op)
        }
      } else {
        ops.unshift(op)
      }
    }
  })

  const undoPos = root._state.getIn(['opSet', 'undoPos'])
  const opSet = root._state.get('opSet')
    .update('undoStack', stack => {
      return stack
        .slice(0, undoPos)
        .push(newState.getIn(['opSet', 'undoLocal']))
    })
    .set('undoPos', undoPos + 1)
    .set('redoStack', List())
  return applyNewChange(root, opSet, ops, message)
}

function makeUndo(root, message) {
  const undoPos = root._state.getIn(['opSet', 'undoPos'])
  const undoOps = root._state.getIn(['opSet', 'undoStack', undoPos - 1])
  if (undoPos < 1 || !undoOps) {
    throw new RangeError('Cannot undo: there is nothing to be undone')
  }

  let opSet = root._state.get('opSet')
  let redoOps = List().withMutations(redoOps => {
    for (let op of undoOps) {
      if (!['set', 'del', 'link'].includes(op.get('action'))) {
        throw new RangeError('Unexpected operation type in undo history: ' + op)
      }

      const fieldOps = OpSet.getFieldOps(opSet, op.get('obj'), op.get('key'))
      if (fieldOps.isEmpty()) {
        redoOps.push(Map({action: 'del', obj: op.get('obj'), key: op.get('key')}))
      } else {
        for (let fieldOp of fieldOps) {
          redoOps.push(fieldOp.remove('actor').remove('seq'))
        }
      }
    }
  })

  opSet = opSet
    .set('undoPos', undoPos - 1)
    .update('redoStack', stack => stack.push(redoOps))
  return applyNewChange(root, opSet, undoOps, message)
}

function makeRedo(root, message) {
  const redoOps = root._state.getIn(['opSet', 'redoStack']).last()
  if (!redoOps) {
    throw new RangeError('Cannot redo: the last change was not an undo')
  }

  const opSet = root._state.get('opSet')
    .update('undoPos', undoPos => undoPos + 1)
    .update('redoStack', stack => stack.pop())
  return applyNewChange(root, opSet, redoOps, message)
}

function applyChanges(doc, changes) {
  checkTarget('applyChanges', doc)
  const incremental = (doc._state.getIn(['opSet', 'history']).size > 0)
  const opSet = doc._state.get('opSet')
  if (isImmutable(doc)) {
    return ImmutableAPI.applyChanges(doc, opSet, fromJS(changes), incremental)
  } else {
    return FreezeAPI.applyChanges(doc, opSet, fromJS(changes), incremental)
  }
}

function merge(local, remote) {
  checkTarget('merge', local)
  if (local._state.get('actorId') === remote._state.get('actorId')) {
    throw new RangeError('Cannot merge an actor with itself')
  }

  const opSet = local._state.get('opSet')
  const changes = OpSet.getMissingChanges(remote._state.get('opSet'), opSet.get('clock'))
  if (isImmutable(local)) {
    return ImmutableAPI.applyChanges(local, opSet, changes, true)
  } else {
    return FreezeAPI.applyChanges(local, opSet, changes, true)
  }
}

module.exports = {
  checkTarget, isObject, isImmutable,
  makeChange, makeUndo, makeRedo,
  applyChanges,
  merge,
}
