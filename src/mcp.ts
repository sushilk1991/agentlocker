import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { audit } from './audit';
import { callTool, toolDefinitions } from './mcp-tools';
import { Context } from './types';

// A fresh transport per request. Neither a session ID nor memory grants access.
export async function handleMcp(c: Context, request: Request) {
 if(request.method!=='POST') {
  await audit(c,'mcp.request','/mcp','deny','method_not_allowed',{status:405});
  return Response.json({jsonrpc:'2.0',id:null,error:{code:-32000,message:'Use POST. Standalone SSE and session deletion are not supported.'}},
   {status:405,headers:{allow:'POST'}});
 }
 const server=new Server({name:'agentlocker',version:'0.1.0'},{capabilities:{tools:{}}});
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:7*1024*1024});
 server.setRequestHandler(ListToolsRequestSchema,async()=> {
  await audit(c,'mcp.tools.list','/mcp','allow','listed');
  return {tools:toolDefinitions()};
 });
 server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>callTool(c,request.params.name,request.params.arguments,extra.signal));
 try {
  await audit(c,'mcp.request','/mcp','allow','intent');
  await server.connect(transport);
  return await transport.handleRequest(request);
 } finally {await server.close();}
}
