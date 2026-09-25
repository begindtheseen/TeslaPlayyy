export default async function handler(req,res){
  const q=String(req.query.query||'').trim();
  if(!q)return res.status(400).json({error:'Missing query'});
  const key=process.env.YOUTUBE_API_KEY;
  if(!key)return res.status(500).json({error:'YOUTUBE_API_KEY is not configured'});
  const u=new URL('https://www.googleapis.com/youtube/v3/search');
  u.searchParams.set('part','snippet');u.searchParams.set('q',q);u.searchParams.set('type','video');u.searchParams.set('maxResults','12');u.searchParams.set('key',key);
  const r=await fetch(u);const d=await r.json();
  if(!r.ok)return res.status(r.status).json({error:d?.error?.message||'YouTube API error'});
  res.status(200).json(d);
}
