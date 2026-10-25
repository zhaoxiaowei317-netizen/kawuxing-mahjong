import {createServer} from 'node:http';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {Rooms} from './rooms.js';
const directory=resolve(process.env.DATA_DIR||'data');mkdirSync(directory,{recursive:true});const file=resolve(directory,'rooms.json');
let snapshot=[];try{snapshot=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const rooms=new Rooms(snapshot),root=resolve('dist');
function save(){writeFileSync(file+'.tmp',JSON.stringify([...rooms.rooms]));renameSync(file+'.tmp',file);}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const origins=new Set((process.env.ALLOWED_ORIGINS||'https://kyleyuenyang.github.io').split(','));
const server=createServer(async(req,res)=>{
 try{
  const origin=req.headers.origin;if(origin){if(!origins.has(origin)&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)return json(res,403,{error:'来源未授权'});res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.writeHead(204).end();return;}
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   let body={};if(req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw Error('请求过大');}body=JSON.parse(raw||'{}');}
   const token=(req.headers.authorization||'').replace(/^Bearer /,'');let data;
   if(url.pathname==='/api/create'&&req.method==='POST')data=rooms.create(body);
   else if(url.pathname==='/api/join'&&req.method==='POST')data=rooms.join(String(body.code),body);
   else if(url.pathname==='/api/leave'&&req.method==='POST')data=rooms.leave(String(body.code),token);
   else if(url.pathname==='/api/room'&&req.method==='GET'){const r=rooms.rooms.get(url.searchParams.get('code'));if(!r)throw Error('房间不存在');data=rooms.view(r,token);}
   else if(url.pathname==='/api/action'&&req.method==='POST')data=rooms.action(String(body.code),token,body);
   else return json(res,404,{error:'接口不存在'});
   if(req.method==='POST')save();return json(res,200,data);
  }
  const path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/online.html':url.pathname));if(!path.startsWith(root+sep))throw Error('路径无效');
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.txt':'text/plain'};res.setHeader('Content-Type',types[extname(path)]||'application/octet-stream');res.end(readFileSync(path));
 }catch(e){json(res,400,{error:e.message});}
});
const timer=setInterval(()=>{if(rooms.tick())save();},250);
server.listen(Number(process.env.PORT||8789),'0.0.0.0',()=>console.log('Mahjong server ready'));
function stop(){clearInterval(timer);server.close();}process.on('SIGTERM',stop);process.on('SIGINT',stop);
