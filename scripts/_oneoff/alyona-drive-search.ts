import { PrismaClient } from '@prisma/client'
import { getAuthedClientForWorkspace } from '../../src/lib/google'

const prisma = new PrismaClient()

;(async () => {
  const workspaceId = '739bcd71-69fd-4b30-a39e-242521b7ab20'
  const meetingCode = 'jaj-acxe-ayr'
  const meetingDate = '2026-05-29'

  const authed = await getAuthedClientForWorkspace(workspaceId)
  if (!authed) {
    console.log('No connected Google client for workspace')
    process.exit(1)
  }
  const tok = await authed.client.getAccessToken()
  const headers = { Authorization: `Bearer ${tok.token!}` }

  // Search 1: files containing meeting code in name
  console.log('=== files with meeting code in name ===')
  let q = `name contains '${meetingCode}' and trashed=false`
  let r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,createdTime,webViewLink)&pageSize=20`, { headers })
  let j: any = await r.json()
  console.log('matches:', j.files?.length || 0)
  for (const f of j.files || []) console.log(' ', f.id, f.mimeType, f.createdTime, '  ', f.name)

  // Search 2: video files created on meeting date
  console.log('\n=== video files created on '+meetingDate+' ===')
  q = `mimeType contains 'video/' and createdTime > '${meetingDate}T13:00:00Z' and createdTime < '${meetingDate}T18:00:00Z' and trashed=false`
  r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,createdTime,webViewLink)&pageSize=20`, { headers })
  j = await r.json()
  console.log('matches:', j.files?.length || 0)
  for (const f of j.files || []) console.log(' ', f.id, f.mimeType, f.createdTime, '  ', f.name)

  // Search 3: anything created near the transcript file (find transcript's parent folder)
  console.log('\n=== transcript file metadata ===')
  r = await fetch(`https://www.googleapis.com/drive/v3/files/1bKhO5OQRZiG-e3qzeQHwEWdJ6aJJo9BYuhOhWlWizYE?fields=id,name,mimeType,createdTime,parents,webViewLink`, { headers })
  console.log(await r.json())

  // Search 4: files in Meet Recordings folder created around meeting time
  console.log('\n=== Meet Recordings folder lookup ===')
  q = `name='Meet Recordings' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, { headers })
  j = await r.json()
  console.log('folder matches:', j.files?.length || 0)
  for (const f of j.files || []) {
    console.log(' folder:', f.id, f.name)
    const folderQ = `'${f.id}' in parents and createdTime > '${meetingDate}T13:00:00Z' and createdTime < '${meetingDate}T18:00:00Z' and trashed=false`
    const fr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(folderQ)}&fields=files(id,name,mimeType,createdTime,webViewLink)&pageSize=30`, { headers })
    const fj: any = await fr.json()
    console.log('   files in window:', fj.files?.length || 0)
    for (const ff of fj.files || []) console.log('   ', ff.id, ff.mimeType, ff.createdTime, '  ', ff.name)
  }

  await prisma.$disconnect()
})()
