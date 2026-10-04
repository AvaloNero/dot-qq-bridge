function freeze(value) { if(value&&typeof value==='object'){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value; }
export const callbackTransportStatusSchema=freeze({type:'object',properties:{
  ready:{type:'boolean'},mode:{type:'string',enum:['direct','managed','blocked']},
  reason:{type:'string',enum:['none','proxy_policy_unverified','proxy_unsupported','adapter_invalid','transport_unverified']},
  proxy_configured:{type:['boolean','null']},destination_binding:{type:'string',enum:['direct_pinned','delegated_unverified','unverified']},
  network_checked:{type:'boolean',const:false}},
  required:['ready','mode','reason','proxy_configured','destination_binding','network_checked'],additionalProperties:false});
export function projectCallbackTransportStatus(value) {
  const fields=callbackTransportStatusSchema.required;
  const fail=()=>{const error=new Error('Invalid callback transport status');error.code='invalid_response';error.reason='invalid_response';throw error;};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(name=>!Object.hasOwn(value,name))||
    typeof value.ready!=='boolean'||value.network_checked!==false||!['direct','managed','blocked'].includes(value.mode)||
    !['none','proxy_policy_unverified','proxy_unsupported','adapter_invalid','transport_unverified'].includes(value.reason)||
    ![true,false,null].includes(value.proxy_configured)||!['direct_pinned','delegated_unverified','unverified'].includes(value.destination_binding))fail();
  const valid=value.mode==='direct' ? value.ready&&value.reason==='none'&&value.proxy_configured===false&&value.destination_binding==='direct_pinned' :
    value.mode==='managed' ? value.ready&&value.reason==='none'&&value.proxy_configured===true&&value.destination_binding==='delegated_unverified' :
    !value.ready&&value.destination_binding==='unverified'&&(
      (value.reason==='proxy_policy_unverified'&&value.proxy_configured===true)||
      (['proxy_unsupported','adapter_invalid'].includes(value.reason)&&typeof value.proxy_configured==='boolean')||
      (value.reason==='transport_unverified'&&value.proxy_configured===null));
  if(!valid)fail();
  return Object.freeze(Object.fromEntries(fields.map(name=>[name,value[name]])));
}
