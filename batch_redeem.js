import { ethers } from "ethers";
import { positions } from "./positions.js"; // 导入你的数据

// ========== 配置 ==========
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // ✅ 正确地址
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PROXY_WALLET_ADDRESS = "0x0953e9c32b8964E6396cB14ABb4Fee92099CAEf1";
const RPC = "https://polygon-bor.publicnode.com";

// ========== ABI ==========
const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data) external",
  "function balanceOf(address account, uint256 id) view returns (uint256)"
];
const USDC_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)"
];
const GNOSIS_SAFE_ABI = [
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  "function nonce() view returns (uint256)"
];

// ========== 工具函数：Gnosis Safe 交易执行 ==========
async function execSafeTransaction(signer, safeContract, to, data, provider) {
    const chainId = (await provider.getNetwork()).chainId;
    const nonce = await safeContract.nonce();
    
    const safeTx = {
        to: to, value: 0, data: data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, 
        gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce: Number(nonce)
    };

    const domain = { verifyingContract: await safeContract.getAddress(), chainId: Number(chainId) };
    const types = {
        SafeTx: [
            { type: "address", name: "to" }, { type: "uint256", name: "value" }, { type: "bytes", name: "data" },
            { type: "uint8", name: "operation" }, { type: "uint256", name: "safeTxGas" }, { type: "uint256", name: "baseGas" },
            { type: "uint256", name: "gasPrice" }, { type: "address", name: "gasToken" }, { type: "address", name: "refundReceiver" },
            { type: "uint256", name: "nonce" }
        ]
    };

    const signature = await signer.signTypedData(domain, types, safeTx);
    
    const feeData = await provider.getFeeData();
    // 稍微提高 Gas 保证成交
    const maxFeePerGas = feeData.maxFeePerGas ? feeData.maxFeePerGas * 2n : ethers.parseUnits("300", "gwei");
    const maxPriorityFeePerGas = ethers.parseUnits("50", "gwei");

    const tx = await safeContract.execTransaction(
        safeTx.to, safeTx.value, safeTx.data, safeTx.operation, safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice, 
        safeTx.gasToken, safeTx.refundReceiver, signature,
        { maxFeePerGas, maxPriorityFeePerGas, gasLimit: 500000 }
    );
    return tx;
}

async function waitForConfirmation(provider, txHash, stepName) {
    console.log(`   ⏳ 等待 ${stepName} 确认... (Hash: ${txHash})`);
    const receipt = await provider.waitForTransaction(txHash, 1);
    if (receipt.status !== 1) throw new Error(`${stepName} 交易失败`);
    console.log(`   ✅ ${stepName} 成功! (Block: ${receipt.blockNumber})`);
}

// ========== 主逻辑 ==========
async function main() {
    console.log("\n🚀 开始执行批量 Redeem 脚本\n");
    
    const provider = new ethers.JsonRpcProvider(RPC);
    const signer = new ethers.Wallet(process.env.POLYSNIPER_PRIVATE_KEY, provider);
    
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
    const proxyWallet = new ethers.Contract(PROXY_WALLET_ADDRESS, GNOSIS_SAFE_ABI, signer);

    // 1. 遍历并 Redeem 所有 positions
    console.log(`📋 发现 ${positions.length} 个待处理仓位`);
    
    let redeemedCount = 0;

    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        console.log(`\nProcessing [${i + 1}/${positions.length}]: ${pos.title} (${pos.outcome})`);

        if (!pos.redeemable) {
            console.log("   ⚠️ 跳过: 标记为不可 Redeem");
            continue;
        }

        // 检查链上余额，防止重复 Redeem 报错
        const balance = await ctf.balanceOf(PROXY_WALLET_ADDRESS, pos.asset);
        if (balance === 0n) {
            console.log("   ⚠️ 跳过: 链上余额为 0 (可能已 Redeem)");
            continue;
        }

        try {
            // 计算 Index Set
            const indexSet = 1 << pos.outcomeIndex;
            
            // 构造 Redeem 数据
            const redeemCalldata = ctf.interface.encodeFunctionData("redeemPositions", [
                USDC_ADDRESS,
                ethers.ZeroHash,
                pos.conditionId,
                [indexSet]
            ]);

            // 执行 Safe 交易
            const tx = await execSafeTransaction(signer, proxyWallet, CTF_ADDRESS, redeemCalldata, provider);
            await waitForConfirmation(provider, tx.hash, "Redeem");
            redeemedCount++;
            
        } catch (err) {
            console.error(`   ❌ Redeem 失败: ${err.message}`);
        }
    }

    console.log(`\n🎉 Redeem 阶段完成! 成功处理: ${redeemedCount} 个`);

    // 2. 统一从 CTF 提取 USDC (Withdraw)
    const usdcTokenId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [USDC_ADDRESS]));
    const ctfBalance = await ctf.balanceOf(PROXY_WALLET_ADDRESS, usdcTokenId);

    if (ctfBalance > 0n) {
        console.log(`\n🏦 发现 CTF 内部滞留资金: ${ethers.formatUnits(ctfBalance, 6)} USDC`);
        console.log("   📤 正在从 CTF 提取到 Proxy Wallet...");

        const withdrawCalldata = ctf.interface.encodeFunctionData("safeTransferFrom", [
            PROXY_WALLET_ADDRESS,
            PROXY_WALLET_ADDRESS,
            usdcTokenId,
            ctfBalance,
            "0x"
        ]);

        try {
            const tx = await execSafeTransaction(signer, proxyWallet, CTF_ADDRESS, withdrawCalldata, provider);
            await waitForConfirmation(provider, tx.hash, "Withdraw from CTF");
        } catch (err) {
            console.error("   ❌ 提现失败:", err);
        }
    } else {
        console.log("\n🏦 CTF 内部无余额，无需提取。");
    }
     console.log("\n✅ ✅ ✅ 全部资金已回收!");

    // 3. 统一转账回 EOA
    // const finalProxyBalance = await usdc.balanceOf(PROXY_WALLET_ADDRESS);
    
    if (finalProxyBalance > 100n) { // 大于 0.0001 USDC
        // console.log(`\n💰 Proxy Wallet 最终余额: ${ethers.formatUnits(finalProxyBalance, 6)} USDC`);
        // console.log(`   💸 正在全额转回 EOA: ${signer.address}`);

        // const transferCalldata = usdc.interface.encodeFunctionData("transfer", [
        //     signer.address,
        //     finalProxyBalance
        // ]);

        // try {
        //     const tx = await execSafeTransaction(signer, proxyWallet, USDC_ADDRESS, transferCalldata, provider);
        //     await waitForConfirmation(provider, tx.hash, "Transfer to EOA");
        //     console.log("\n✅ ✅ ✅ 全部资金已回收!");
        // } catch (err) {
        //     console.error("   ❌ 转账失败:", err);
        // }
    } else {
        console.log("\n💰 Proxy Wallet 余额过低，不执行转账。");
    }
}

main().catch(console.error);