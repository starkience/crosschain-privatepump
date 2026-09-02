import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import type {
  ExecutionCall,
  RelayExecutionRequest,
  RelayerFee,
} from "@private-launchpad/sdk";

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw new Error(`${field} must be a 20-byte EVM address`);
  }
  return getAddress(value);
}

function hex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !isHex(value))
    throw new Error(`${field} must be hex`);
  return value;
}

function uint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be an unsigned base-10 integer string`);
  }
  return BigInt(value);
}

function safeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function parseRelayRequest(value: unknown): RelayExecutionRequest {
  const input = record(value, "request");
  if (!Array.isArray(input.calls)) throw new Error("calls must be an array");
  const calls: ExecutionCall[] = input.calls.map((raw, index) => {
    const call = record(raw, `calls[${index}]`);
    return {
      target: address(call.target, `calls[${index}].target`),
      value: uint(call.value, `calls[${index}].value`),
      data: hex(call.data, `calls[${index}].data`),
    };
  });
  const rawFee = record(input.fee, "fee");
  const fee: RelayerFee = {
    token: address(rawFee.token, "fee.token"),
    amount: uint(rawFee.amount, "fee.amount"),
    recipient: address(rawFee.recipient, "fee.recipient"),
  };
  const relayRequestId = optionalRelayRequestId(input.relayRequestId);
  const relayQuoteAttestation = optionalRelayQuoteAttestation(
    input.relayQuoteAttestation,
  );
  return {
    chainId: safeNumber(input.chainId, "chainId"),
    factory: address(input.factory, "factory"),
    account: address(input.account, "account"),
    owner: address(input.owner, "owner"),
    accountIndex: safeNumber(input.accountIndex, "accountIndex"),
    calls,
    nonce: uint(input.nonce, "nonce"),
    deadline: uint(input.deadline, "deadline"),
    prefund: uint(input.prefund, "prefund"),
    fee,
    signature: hex(input.signature, "signature"),
    ...(relayRequestId ? { relayRequestId } : {}),
    ...(relayQuoteAttestation ? { relayQuoteAttestation } : {}),
  };
}

export function relayRequestJson(
  request: RelayExecutionRequest,
): Record<string, unknown> {
  return {
    ...request,
    calls: request.calls.map((call) => ({
      ...call,
      value: call.value.toString(),
    })),
    nonce: request.nonce.toString(),
    deadline: request.deadline.toString(),
    prefund: request.prefund.toString(),
    fee: { ...request.fee, amount: request.fee.amount.toString() },
  };
}

function optionalRelayRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("relayRequestId must be a 32-byte hex request ID");
  }
  return value.toLowerCase();
}

function optionalRelayQuoteAttestation(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > 2_048 ||
    !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error("relayQuoteAttestation must be a valid v1 attestation");
  }
  return value;
}
