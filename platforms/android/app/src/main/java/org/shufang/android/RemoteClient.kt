package org.shufang.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URI
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

object RemoteAddress {
    fun normalize(input: String): String {
        val uri = URI(input.trim())
        require(uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.path in listOf("", "/")) { "请输入不含路径或凭据的 HTTPS 服务器地址" }
        return "https://${uri.host.lowercase()}${if (uri.port >= 0 && uri.port != 443) ":${uri.port}" else ""}"
    }
    fun identity(origin: String, user: String) = MessageDigest.getInstance("SHA-256").digest("$origin\u0000$user".toByteArray()).joinToString("") { "%02x".format(it) }
}

object CredentialMode {
    fun headers(mode:String,credential:String):Map<String,String> {
        require(credential.isNotBlank() && !credential.contains('\r') && !credential.contains('\n')) {"invalid_credential"}
        return when(mode){"account"->mapOf("Cookie" to credential);"node"->mapOf("Authorization" to "Bearer $credential");else->error("invalid_auth_mode")}
    }
}

class RemoteClient(private val vault: SecretVault, val origin: String, val account: String, val mode:String="account") {
    val identity = RemoteAddress.identity(origin, if(mode=="node")"node:$account"else account)
    private val credentialName get()=if(mode=="node")"node:$identity"else "cookie:$identity"
    fun token(value:String){require(mode=="node");CredentialMode.headers(mode,value);vault.put(credentialName,value)}
    fun renamed(account:String):RemoteClient {
        require(mode=="account");val client=RemoteClient(vault,origin,account)
        vault.get(credentialName)?.let {vault.put("cookie:${client.identity}",it)}
        if(client.identity!=identity)vault.remove(credentialName)
        return client
    }
    suspend fun request(path: String, method: String = "GET", body: JSONObject? = null,timeout:Int=60_000): JSONObject = withContext(Dispatchers.IO) {
        require(path.startsWith("/api/") && !path.contains(".."))
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 15_000; connection.readTimeout = timeout
        connection.requestMethod = method
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Origin", origin)
        vault.get(credentialName)?.let {value->CredentialMode.headers(mode,value).forEach {(key,header)->connection.setRequestProperty(key,header)}}
        try {
            body?.let {
                connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { stream -> stream.write(it.toString().toByteArray()) }
            }
            val status = connection.responseCode
            connection.headerFields.entries.filter { it.key.equals("Set-Cookie", true) }.flatMap { it.value }.firstOrNull { it.startsWith("shufang_session=") }?.let {
                if(mode=="account")vault.put(credentialName, it.substringBefore(';'))
            }
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { input ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while(true) { val count = input.read(buffer); if(count<0)break; output.write(buffer,0,count); require(output.size()<=2*1024*1024) {"服务器响应过大"} }
                output.toByteArray()
            } ?: byteArrayOf()
            require(bytes.size <= 2 * 1024 * 1024) { "服务器响应过大" }
            RemoteResponse.decode(status,connection.contentType,bytes.toString(Charsets.UTF_8))
        } finally { connection.disconnect() }
    }
    suspend fun login(id: String, secret: String):JSONObject {require(mode=="account");return request("/api/auth/login", "POST", JSONObject().put("appId", id).put("appSecret", secret))}
    fun syncArguments(nodeId:String):JSONObject {
        val value=vault.get(credentialName)?:error("请先登录或配置节点令牌")
        CredentialMode.headers(mode,value)
        return JSONObject().put("id",nodeId).put("url",origin).put("token",if(mode=="node")value else "").apply {if(mode=="account")put("cookie",value)}
    }
    suspend fun logout() {try {if(mode=="account")runCatching {request("/api/auth/logout", "POST", JSONObject())}}finally {vault.remove(credentialName)} }
}
