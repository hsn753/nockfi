#!/bin/bash
# Auto-deploy script - ensures code goes to production
set -e

echo "🚀 Deploying to production..."
echo ""

# Commit and push
git add -A
git commit -m "${1:-Update}" || echo "No changes to commit"
git push

# Wait a moment for GitHub to sync
sleep 2

# Force production deployment
echo ""
echo "📦 Forcing production deployment..."
npx vercel --prod --yes

# Wait for deployment
sleep 3

# Verify
echo ""
echo "✅ Verifying deployment..."
./check-deployment.sh
