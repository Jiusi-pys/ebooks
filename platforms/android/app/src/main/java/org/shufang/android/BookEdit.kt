package org.shufang.android

import org.json.JSONArray
import org.json.JSONObject

/** Rebase only when every field being edited is unchanged since the UI read it. */
fun canRebaseBookEdit(prior:Record,current:Record,patch:JSONObject):Boolean {
    if(prior.id!=current.id)return false
    fun canonical(value:Any?):String=when(value) {
        is JSONObject->value.keys().asSequence().toList().sorted().joinToString(prefix="{",postfix="}"){JSONObject.quote(it)+":"+canonical(value.get(it))}
        is JSONArray->(0 until value.length()).joinToString(prefix="[",postfix="]"){canonical(value.get(it))}
        is String->JSONObject.quote(value)
        null->"absent"
        else->value.toString()
    }
    return patch.keys().asSequence().all {key->canonical(prior.value.opt(key))==canonical(current.value.opt(key))}
}
