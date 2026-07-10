# Quick Test - What's Breaking

1. Check if wallet address is detected
2. Test balance API directly
3. Fix the issue

## Your wallet address from screenshot:
0xCAB3...f6Df

## Test commands:
```bash
# Test the API
curl "https://nock-main.vercel.app/api/balances?address=0xCAB3f6Df"

# Should return balances, not error
```
