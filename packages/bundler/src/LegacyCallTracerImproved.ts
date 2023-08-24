// Copyright 2017 The go-ethereum Authors
// This file is part of the go-ethereum library.
//
// The go-ethereum library is free software: you can redistribute it and/or modify
// it under the terms of the GNU Lesser General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// The go-ethereum library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public License
// along with the go-ethereum library. If not, see <http://www.gnu.org/licenses/>.

// callTracer is a full blown transaction tracer that extracts and reports all
// the internal calls made by a transaction, along with any useful information.

// functions available in a context of geth tracer
import { LogTracer } from './GethTracer'

declare function toHex (a: any): string

declare function bigInt (a: any): any

declare function toAddress (a: any): string

declare function isPrecompiled (addr: any): boolean

interface Call {
  opcodeCount?: any
  outLen: any
  outOff: any
  output: string
  gas: any | undefined
  gasUsed: string
  error: string | undefined
  calls: Call[] | undefined
  type: string
  from: string
  to: string
  input: string
  gasIn: any
  gasCost: any
  value: string
}

export function legacyCallTracerImproved (): LogTracer & {
  countOpcode: any
  pastOpcodes: any[]
  getPastOpcode: any
  countSlot: (list: { [key: string]: number | undefined }, key: any) => void
  callstack: Call[],
  descended: any
} {

  return {

    pastOpcodes: [],

    // callstack is the current recursive call stack of the EVM execution.
    // TODO: this empty element initialization is required to catch the first CALL* - rewrite
    // @ts-ignore
    callstack: [{}],

    // descended tracks whether we've just descended from an outer transaction into
    // an inner call.
    descended: false,

    // step is invoked for every opcode that the VM executes.
    step: function (log: any, db: any) {
      // Capture any errors immediately
      const error = log.getError()
      if (error !== undefined) {
        this.fault(log, db)
        return
      }
      // We only care about system opcodes, faster if we pre-check once
      const syscall = (log.op.toNumber() & 0xf0) == 0xf0
      let op: string | undefined = undefined
      if (syscall) {
        op = log.op.toString()
      }
      // If a new contract is being created, add to the call stack
      if (syscall && (op == 'CREATE' || op == 'CREATE2')) {
        const inOff = log.stack.peek(1).valueOf()
        const inEnd = inOff + log.stack.peek(2).valueOf()

        // Assemble the internal call report and store for completion
        const call: Call = {
          outLen: 'n/a',
          outOff: 'n/a',
          output: 'n/a',
          gas: undefined,
          gasUsed: 'n/a',
          error: undefined,
          calls: undefined,
          type: op,
          from: toHex(log.contract.getAddress()),
          to: 'n/a',
          input: toHex(log.memory.slice(inOff, inEnd)),
          gasIn: log.getGas(),
          gasCost: log.getCost(),
          value: '0x' + log.stack.peek(0).toString(16)
        }
        this.callstack.push(call)
        this.descended = true
        return
      }
      // If a contract is being self-destructed, gather that as a subcall too
      if (syscall && op == 'SELFDESTRUCT') {
        const left = this.callstack.length
        if (this.callstack[left - 1].calls === undefined) {
          this.callstack[left - 1].calls = []
        }
        this.callstack[left - 1].calls!.push({
          outLen: 'n/a',
          outOff: 'n/a',
          output: 'n/a',
          gas: undefined,
          gasUsed: 'n/a',
          error: undefined,
          calls: undefined,
          input: 'n/a',
          type: op,
          from: toHex(log.contract.getAddress()),
          to: toHex(toAddress(log.stack.peek(0).toString(16))),
          gasIn: log.getGas(),
          gasCost: log.getCost(),
          value: '0x' + db.getBalance(log.contract.getAddress()).toString(16)
        })
        return
      }
      // If a new method invocation is being done, add to the call stack
      if (syscall && (op == 'CALL' || op == 'CALLCODE' || op == 'DELEGATECALL' || op == 'STATICCALL')) {
        // Skip any pre-compile invocations, those are just fancy opcodes
        const to = toAddress(log.stack.peek(1).toString(16))
        if (isPrecompiled(to)) {
          return
        }
        const off = (op == 'DELEGATECALL' || op == 'STATICCALL' ? 0 : 1)

        const inOff = log.stack.peek(2 + off).valueOf()
        const inEnd = inOff + log.stack.peek(3 + off).valueOf()

        // Assemble the internal call report and store for completion
        const call: Call = {
          value: 'n/a',
          output: 'n/a',
          gas: undefined,
          gasUsed: 'n/a',
          error: undefined,
          calls: undefined,
          type: op,
          from: toHex(log.contract.getAddress()),
          to: toHex(to),
          input: toHex(log.memory.slice(inOff, inEnd)),
          gasIn: log.getGas(),
          gasCost: log.getCost(),
          outOff: log.stack.peek(4 + off).valueOf(),
          outLen: log.stack.peek(5 + off).valueOf()
        }
        if (op != 'DELEGATECALL' && op != 'STATICCALL') {
          call.value = '0x' + log.stack.peek(2).toString(16)
        }
        this.callstack.push(call)
        this.descended = true
        return
      }
      // If we've just descended into an inner call, retrieve it's true allowance. We
      // need to extract if from within the call as there may be funky gas dynamics
      // with regard to requested and actually given gas (2300 stipend, 63/64 rule).
      if (this.descended) {
        if (log.getDepth() >= this.callstack.length) {
          this.callstack[this.callstack.length - 1].gas = log.getGas()
        } else {
          // TODO(karalabe): The call was made to a plain account. We currently don't
          // have access to the true gas amount inside the call and so any amount will
          // mostly be wrong since it depends on a lot of input args. Skip gas for now.
        }
        this.descended = false
      }
      // If an existing call is returning, pop off the call stack
      if (syscall && op == 'REVERT') {
        this.callstack[this.callstack.length - 1].error = 'execution reverted'
        return
      }
      if (log.getDepth() == this.callstack.length - 1) {
        // Pop off the last call and get the execution results
        const call = this.callstack.pop()
        if (call == null) {
          throw new Error('call cannot be null here')
        }

        if (call.type == 'CREATE' || call.type == 'CREATE2') {
          // If the call was a CREATE, retrieve the contract address and output code
          call.gasUsed = '0x' + bigInt(call.gasIn - call.gasCost - log.getGas()).toString(16)
          delete call.gasIn
          delete call.gasCost

          const ret = log.stack.peek(0)
          if (!ret.equals(0)) {
            call.to = toHex(toAddress(ret.toString(16)))
            call.output = toHex(db.getCode(toAddress(ret.toString(16))))
          } else if (call.error === undefined) {
            call.error = 'internal failure' // TODO(karalabe): surface these faults somehow
          }
        } else {
          // If the call was a contract call, retrieve the gas usage and output
          if (call.gas !== undefined) {
            call.gasUsed = '0x' + bigInt(call.gasIn - call.gasCost + call.gas - log.getGas()).toString(16)
          }
          const ret = log.stack.peek(0)
          if (!ret.equals(0)) {
            call.output = toHex(log.memory.slice(call.outOff, call.outOff + call.outLen))
          } else if (call.error === undefined) {
            call.error = 'internal failure' // TODO(karalabe): surface these faults somehow
          }
          delete call.gasIn
          delete call.gasCost
          delete call.outOff
          delete call.outLen
        }
        if (call.gas !== undefined) {
          call.gas = '0x' + bigInt(call.gas).toString(16)
        }
        // Inject the call into the previous one
        const left = this.callstack.length
        if (this.callstack[left - 1].calls === undefined) {
          this.callstack[left - 1].calls = []
        }
        this.callstack[left - 1].calls!.push(call)
      }
    },

    // fault is invoked when the actual execution of an opcode fails.
    fault: function (log: any, db: any) {
      // If the topmost call already reverted, don't handle the additional fault again
      if (this.callstack[this.callstack.length - 1].error !== undefined) {
        return
      }
      // Pop off the just failed call
      const call = this.callstack.pop()
      if (call == null) {
        throw new Error('call cannot be null here')
      }

      call.error = log.getError()

      // Consume all available gas and clean any leftovers
      if (call.gas !== undefined) {
        call.gas = '0x' + bigInt(call.gas).toString(16)
        call.gasUsed = call.gas
      }
      delete call.gasIn
      delete call.gasCost
      delete call.outOff
      delete call.outLen

      // Flatten the failed call into its parent
      const left = this.callstack.length
      if (left > 0) {
        if (this.callstack[left - 1].calls === undefined) {
          this.callstack[left - 1].calls = []
        }
        this.callstack[left - 1].calls!.push(call)
        return
      }
      // Last call failed too, leave it in the stack
      this.callstack.push(call)
    },

    // result is invoked when all the opcodes have been iterated over and returns
    // the final result of the tracing.
    result: function (ctx: any, db: any) {
      const result: any = {
        type: ctx.type,
        from: toHex(ctx.from),
        to: toHex(ctx.to),
        value: '0x' + ctx.value.toString(16),
        gas: '0x' + bigInt(ctx.gas).toString(16),
        gasUsed: '0x' + bigInt(ctx.gasUsed).toString(16),
        input: toHex(ctx.input),
        output: toHex(ctx.output),
      }
      if (this.callstack[0].calls !== undefined) {
        result.calls = this.callstack[0].calls
      }
      if (this.callstack[0].error !== undefined) {
        result.error = this.callstack[0].error
      } else if (ctx.error !== undefined) {
        result.error = ctx.error
      }
      if (result.error !== undefined && (result.error !== 'execution reverted' || result.output === '0x')) {
        delete result.output
      }
      return result
    }
  }
}
