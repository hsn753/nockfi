# Testing Guide - NockFi

## 🚨 IMPORTANT: Privy Setup Required

**Before testing, you MUST whitelist the domain in Privy dashboard:**

1. Go to: https://dashboard.privy.io/
2. Select your app (ID: `cmrd7fljy00hk0dih0hlbfmnp`)
3. Go to **Settings** → **Domains**
4. Add these domains:
   - `nock-main.vercel.app`
   - `localhost:3000` (for local testing)
5. Save

**Without this, wallet connection will fail!**

---

## 🧪 Production Testing

### URL: https://nock-main.vercel.app

### Test 1: Wallet Connection
1. Open https://nock-main.vercel.app
2. Click **"Log in"** (top right)
3. Choose wallet provider (MetaMask, WalletConnect, etc.)
4. Connect wallet
5. **Switch to Robinhood Chain** if prompted
   - Chain ID: `4663`
   - RPC: `https://rpc.mainnet.chain.robinhood.com`
6. ✅ Verify wallet address appears in top right

### Test 2: View Live Balances
1. After connecting wallet, go to **"Balances"** tab
2. Wait for loading (should be ~2-3 seconds)
3. ✅ Should see:
   - ETH balance
   - TSLA balance
   - AMD balance
   - AMZN balance
   - NFLX balance
   - PLTR balance
4. ❌ If you see "Could not load balances":
   - Check wallet is on Robinhood Chain
   - Check browser console for errors
   - Try hard refresh

### Test 3: AI Chat
1. Go to **"Chat"** tab
2. Type: **"what do i hold?"**
3. ✅ Robin should respond with your actual balances from blockchain
4. Try: **"swap 100 USDG for TSLA"**
5. ✅ Robin should fetch a real quote from 0x API
6. ✅ Should show exchange rate and preview card

### Test 4: Swap Execution
1. After getting a swap quote, click **"Draw"** to review
2. Click **"Loose"** to execute
3. ✅ Wallet should prompt for transaction signature
4. Sign the transaction
5. ✅ Should see TX hash in chat
6. ✅ Can view transaction on: https://robinhoodchain.blockscout.com

---

## 🐛 Troubleshooting

### Issue: "Log in" button doesn't work
**Solution**: Whitelist domain in Privy dashboard (see top of doc)

### Issue: Wallet won't connect
**Solutions**:
- Make sure Privy domain is whitelisted
- Try clearing browser cache
- Try different wallet provider
- Check browser console for errors

### Issue: "Could not load balances"
**Solutions**:
- Verify wallet is on Robinhood Chain (Chain ID: 4663)
- Check you have some ETH/tokens (try testnet first)
- Check Alchemy RPC is working
- Check browser console for API errors

### Issue: AI chat shows "Something went wrong"
**Solutions**:
- Check Anthropic API key is set
- Check Claude model name is correct (`claude-3-5-sonnet-20241022`)
- Check browser console for 500 errors
- Verify wallet is connected for balance queries

### Issue: Swap fails
**Solutions**:
- Make sure you have enough balance of the token you're selling
- Make sure you have ETH for gas
- Check 0x API key is set correctly
- Verify liquidity exists for the pair
- Check transaction on block explorer for revert reason

---

## 💻 Local Testing

### Setup
```bash
cd nock_tech/nock-main
npm install
# or
pnpm install
```

### Environment Variables
Create `.env.local` (gitignored — pull real values with `vercel env pull .env.local`, never commit them):
```bash
ANTHROPIC_API_KEY=
NEXT_PUBLIC_ALCHEMY_API_KEY=
NEXT_PUBLIC_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<ALCHEMY_KEY>
RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<ALCHEMY_KEY>
NEXT_PUBLIC_PRIVY_APP_ID=cmrd7fljy00hk0dih0hlbfmnp
PRIVY_APP_SECRET=
ZEROX_API_KEY=
```

### Run
```bash
npm run dev
# or
pnpm dev
```

Open http://localhost:3000

---

## ✅ Success Criteria

**For Thursday launch, these must work:**

- [ ] Wallet connection works
- [ ] Balances load from Robinhood Chain
- [ ] AI chat responds intelligently
- [ ] Swap quotes show real exchange rates
- [ ] Swap execution works on-chain
- [ ] Mobile site is responsive
- [ ] No console errors

---

## 📊 Expected Behavior

### Portfolio Value
- Should calculate based on real balances
- Initially shows $0.00 (prices coming soon)
- Updates after swaps

### Dashboard
- Starts empty (no demo data)
- Populates after user executes actions
- Shows real positions and activity

### Chat Flow
1. User asks question → Robin understands intent
2. Robin calls tools (balances, quotes, etc.)
3. Robin responds with real data
4. For actions, Robin shows preview card
5. User reviews and executes
6. Real blockchain transaction happens

---

**Need help?** Check CURRENT_STATUS.md for detailed system info.
