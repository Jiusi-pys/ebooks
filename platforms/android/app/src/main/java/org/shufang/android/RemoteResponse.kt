package org.shufang.android

import org.json.JSONObject

object RemoteResponse {
    fun decode(status:Int,contentType:String?,body:String):JSONObject {
        val json=if(body.isBlank())JSONObject()else runCatching {JSONObject(body)}.getOrNull()
        if(status !in 200..299) {
            if(status==401)error("登录已失效，请重新登录；本地修改已保留（HTTP 401）")
            val code=json?.optString("error")?.takeIf {it.matches(Regex("[a-zA-Z0-9_:-]{1,100}"))}
            val explanation=when(code) {
                "account_store_unavailable"->"服务器账户存储不可用，请检查数据库和磁盘空间"
                "auth_not_configured"->"服务器尚未配置账户认证"
                "read_only_replica"->"服务器目前只读，请连接可写节点"
                else->if(status==503)"服务器暂时不可用，请稍后重试"else "服务器请求失败"
            }
            error("$explanation（HTTP $status${code?.let {" · $it"}.orEmpty()}）")
        }
        require(contentType?.substringBefore(';')?.trim()?.equals("application/json",true)==true && json!=null) {"服务器未返回 JSON；请检查地址和 API 代理配置（HTTP $status）"}
        return json
    }
}
