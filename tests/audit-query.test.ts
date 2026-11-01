import { describe, expect, it } from 'vitest';
import { auditFilter } from '../src/audit-query';
import { csvCell } from '../src/security';

describe('owner audit filters',()=>{
 it('binds all filter values and treats prefixes as path segments',()=>{
  const params=new URLSearchParams({from:'1',to:'200',agent_id:"' OR 1=1",token_id:'token',operation:'file.read',prefix:'/work/',secret:'key',host:'api.example.com',decision:'allow',outcome:'read',request_id:'r',action_id:'a',cursor:'9',limit:'100',include_routine:'false'});
  const f=auditFilter(params);expect(f.where).toContain('id<?');expect(f.where).toContain('substr(target,1,length(?))=?');
  expect(f.where).not.toContain("' OR 1=1");expect(f.args).toContain("' OR 1=1");expect(f.args.filter(v=>v==='/work/')).toHaveLength(2);expect(f.limit).toBe(100);
 });
 it.each(['limit=0','limit=101','from=3&to=2','cursor=-1','cursor=Infinity','limit=1&limit=2','prefix=%2Fwork','path=%2Fwork%2F','include_routine=maybe','format=csv','host='])('rejects malformed filters: %s',query=>{expect(()=>auditFilter(new URLSearchParams(query))).toThrow();});
 it('quotes spreadsheet formulas, quotes, and newlines in CSV cells',()=>{
  for(const value of ['=1+1','+2','-3','@SUM(A1)','\tfoo','\rfoo'])expect(csvCell(value)).toMatch(/^"'/);
  expect(csvCell('one,"two"\nthree')).toBe('"one,""two""\nthree"');
 });
});
