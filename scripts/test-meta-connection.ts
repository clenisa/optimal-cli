/**
 * Test Meta Graph API connection
 * 
 * Run: npx tsx scripts/test-meta-connection.ts
 * 
 * Requires these env vars:
 *   META_ACCESS_TOKEN - Long-lived page access token
 *   META_IG_ACCOUNT_ID - Instagram Business Account ID
 * 
 * To get credentials:
 * 1. Go to https://business.facebook.com/settings/system-users
 * 2. Create or use a system user
 * 3. Assign the user "Meta Express" app with assets (pages + IG accounts)
 * 4. Generate long-lived access token
 * 5. Get IG account ID via Graph API Explorer:
 *    GET /me/accounts → page_id
 *    GET /{page_id}?fields=instagram_business_account
 */

import { getMetaConfig, setFetchForTests } from '../lib/social/meta'

async function testConnection() {
  console.log('🔗 Testing Meta Graph API Connection\n')

  try {
    // Get config (throws if env vars missing)
    const config = getMetaConfig()
    console.log('✅ Config loaded')
    console.log(`   IG Account ID: ${config.igAccountId}`)

    // Test API call: get IG account info
    const testUrl = `https://graph.facebook.com/v21.0/${config.igAccountId}?fields=id,name,username,media_count&access_token=${config.accessToken}`
    
    console.log('\n📡 Fetching IG account info...')
    const response = await fetch(testUrl)
    const data = await response.json() as Record<string, unknown>

    if (!response.ok) {
      const err = data.error as { message?: string } | undefined
      console.log(`❌ API Error: ${err?.message ?? 'Unknown'}`)
      console.log('   Full response:', JSON.stringify(data, null, 2))
      process.exit(1)
    }

    console.log('✅ Connected to Instagram Business Account!')
    console.log(`   Account ID: ${(data as any).id}`)
    console.log(`   Username: ${(data as any).username}`)
    console.log(`   Media Count: ${(data as any).media_count}`)
    console.log('\n✨ Meta Graph API is connected and working!')

  } catch (err) {
    if (err instanceof Error) {
      console.log(`❌ ${err.message}`)
      
      if (err.message.includes('META_ACCESS_TOKEN')) {
        console.log('\n📋 To get your access token:')
        console.log('   1. Go to https://business.facebook.com/settings/system-users')
        console.log('   2. Create a system user or use existing')
        console.log('   3. Assign assets (pages + IG accounts) to the system user')
        console.log('   4. Generate long-lived access token')
        console.log('   5. Add to .env: META_ACCESS_TOKEN=<token>')
      }
      
      if (err.message.includes('META_IG_ACCOUNT_ID')) {
        console.log('\n📋 To get your IG account ID:')
        console.log('   1. Go to https://developers.facebook.com/tools/explorer/')
        console.log('   2. Select your app → GET → /me/accounts')
        console.log('   3. Copy your page ID')
        console.log('   4. GET /{page_id}?fields=instagram_business_account')
        console.log('   5. Copy the instagram_business_account id')
        console.log('   6. Add to .env: META_IG_ACCOUNT_ID=<id>')
      }
    }
    process.exit(1)
  }
}

testConnection()