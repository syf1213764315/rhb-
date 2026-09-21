import { createPublicClient, http } from "viem";
import { robinChain } from "../server/chain.js";
import { isLaunchTarget, parseLaunchFromReceipt } from "../server/create-detect.js";

const c = createPublicClient({
  chain: robinChain,
  transport: http(robinChain.rpcUrls.default.http[0]),
});

const cases = [
  {
    hash: "0x85c1058d3d5babccc3a0279c7a0b12b958d4cb96526e5e4242cfb07750f90436",
    token: "0x1be2b53ffc5e6afaae389fb473848c47c76ec62a",
    creator: "0xedaa4c0e0056ed6a17a755493c283296fe8202bb",
  },
  {
    hash: "0xdb4190a1e2f748716f55b6474c2de92a0986063b817addf2dbca9d467d71a271",
    token: "0x5232f114fa53b48011b5c66f30f3b368b3b1c57b",
    creator: "0xedaa4c0e0056ed6a17a755493c283296fe8202bb",
  },
];

for (const { hash, token, creator } of cases) {
  const tx = await c.getTransaction({ hash });
  const rc = await c.getTransactionReceipt({ hash });
  const launch = parseLaunchFromReceipt(rc, creator);
  const ok =
    isLaunchTarget(tx.to) &&
    launch?.token.toLowerCase() === token.toLowerCase() &&
    launch.poolKey != null;
  console.log(hash.slice(0, 12), ok ? "OK" : "FAIL", launch?.token, "poolKey", !!launch?.poolKey);
}
