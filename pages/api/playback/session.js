export default function handler(req,res){
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 const id=String(req.query.videoId||'');
 if(id==='demo')return res.status(200).json({streamUrl:'/media/demo.ts',mode:'local-demo',audio:false});
 if(!/^[A-Za-z0-9_-]{11}$/.test(id))return res.status(400).json({error:'Invalid video ID'});
 // Deliberately do NOT treat YouTube watch URLs as media streams.
 // Replace this with an authorized streaming provider you control.
 return res.status(501).json({error:'YouTube media playback backend not connected',detail:'Search is metadata-only. See docs/BACKEND_CONTRACT.md.'});
}
