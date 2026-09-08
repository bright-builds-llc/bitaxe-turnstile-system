import { expect, test } from "bun:test";
import vectors from "../conformance/bwg-worker-controller-0.4/difficulty-hint-vectors.json";
import {parseWorkerLeaseGrant} from "./worker-controller-semantics";
import {parseWorkLeaseAuthorityTrust,verifyWorkerLeaseAuthorization,type WorkerLeaseAuthorizationInput} from "./worker-lease-authorization";
import {WORKER_SERIAL_MANIFEST,parseWorkerSerialManifest,workerSerialManifestSha256} from "./worker-serial";

test("signed hint vectors preserve absent, explicit zero and u16 values",async()=>{
 // Arrange
 const trust=parseWorkLeaseAuthorityTrust(vectors.trust);
 for(const vector of vectors.vectors){
  // Act
  const grant=parseWorkerLeaseGrant({...vector.input.request,authorization:vector.authorization});
  const verified=await verifyWorkerLeaseAuthorization(vector.authorization,vector.input as WorkerLeaseAuthorizationInput,trust);
  // Assert
  expect(verified.sequence).toBeGreaterThan(0n);
  expect(Object.hasOwn(grant.stratum,"suggestedDifficulty")).toBe(vector.id!=="omitted");
  expect(grant.stratum.suggestedDifficulty).toBe((vector.input.request.stratum as {suggestedDifficulty?:number}).suggestedDifficulty);
 }
});
test("hint tampering including removal of signed zero invalidates authorization",async()=>{
 // Arrange
 const trust=parseWorkLeaseAuthorityTrust(vectors.trust);
 for(const vector of vectors.vectors){
  const input=structuredClone(vector.input) as WorkerLeaseAuthorizationInput;
  if(input.operation!=="start")throw Error("fixture_operation");
  if(vector.id==="hint_0")delete input.request.stratum.suggestedDifficulty;
  else input.request.stratum.suggestedDifficulty=1;
  // Act / Assert
  await expect(verifyWorkerLeaseAuthorization(vector.authorization,input,trust)).rejects.toThrow();
 }
});
test("untrusted suggested difficulty rejects null, negative, fraction and overflow",()=>{
 // Arrange
 const vector=vectors.vectors[0]!;
 for(const hint of [null,-1,1.5,65536,"1000",undefined]){
  // Act / Assert
  expect(()=>parseWorkerLeaseGrant({...vector.input.request,authorization:vector.authorization,stratum:{...vector.input.request.stratum,suggestedDifficulty:hint}})).toThrow();
 }
});
test("manifest advertises exact difficulty hint semantics and rejects old binding",async()=>{
 // Arrange
 const {poolDifficultyHintProfile: _hint, ...previous}=WORKER_SERIAL_MANIFEST;
 // Act / Assert
 expect(()=>parseWorkerSerialManifest(previous)).toThrow();
 expect(await workerSerialManifestSha256()).toBe("pDwsfWH5X8bHMTqyB0SgAxTKA0_KpzBqdSLxMpKVNhU");
});
