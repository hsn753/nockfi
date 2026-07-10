#!/bin/bash
echo "🔍 Checking deployment status..."
echo ""
echo "📦 Latest local commit:"
git log -1 --oneline
echo ""
echo "🌐 Live deployment:"
curl -s https://nock-main.vercel.app/api/health | jq .
echo ""
echo "✅ If version matches commit SHA, deployment is live!"
