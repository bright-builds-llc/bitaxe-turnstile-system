#!/usr/bin/env bun
/** Public RFC8032 conformance only; no deployment material is read. */
import {writeFile} from "node:fs/promises";
import prior from "../conformance/bwg-worker-controller-0.4/qualification-attempt-vectors.json";
import {signWorkerLeaseAuthorization, type WorkerLeaseAuthorizationInput} from "../web/worker-lease-authorization";
import {canonicalJson} from "../web/headless-values";
const privateKey=await crypto.subtle.importKey("pkcs8",Buffer.from("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60","hex"),"Ed25519",false,["sign"]);
const vectors=[];
for(const [index,maybeHint]of [undefined,0,1000,65535].entries()){
 const input=structuredClone(prior.vectors[0]!.input) as WorkerLeaseAuthorizationInput;
 if(input.operation!=="start")throw Error("fixture_operation");
 if(maybeHint!==undefined)input.request.stratum.suggestedDifficulty=maybeHint;
 const authorization=await signWorkerLeaseAuthorization({input,sequence:String(index+1),kid:"rfc8032",issuer:prior.trust.issuer,audience:prior.trust.audience,privateKey});
 vectors.push({id:maybeHint===undefined?"omitted":`hint_${maybeHint}`,input,authorization,canonical_request:canonicalJson(input.request)});
}
await writeFile("conformance/bwg-worker-controller-0.4/difficulty-hint-vectors.json",JSON.stringify({classification:"public-rfc8032-conformance-only",trust:prior.trust,vectors},null,2)+"\n");
