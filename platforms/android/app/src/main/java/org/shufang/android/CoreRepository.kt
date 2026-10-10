package org.shufang.android

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import shufang.core.NativeCore
import java.io.File
import java.util.UUID

data class Record(val revision: Long, val value: JSONObject) {
    val id: String get() = value.getString("id")
    fun text(key: String) = value.optString(key)
    companion object { fun from(json: JSONObject) = Record(json.getLong("revision"), json.getJSONObject("value")) }
}

class CoreRepository(context: Context, val key: String = "local") {
    private val vault = SecretVault(context)
    val root = File(context.filesDir, "workspaces/$key").apply { mkdirs() }
    private var session: String? = null
    var workspaceId:String="local-android";private set
    private val gate = Mutex()
    suspend fun open(workspace: String = "local-android") = withContext(Dispatchers.IO) {
        gate.withLock {
            if (session == null) {
                val encryption = vault.nativeKey()
                native(JSONObject().put("command", "sessionConfigureVault").put("key", encryption))
                val identity = File(root, "replica-id")
                if (!identity.exists()) identity.writeText(UUID.randomUUID().toString())
                session = native(JSONObject().put("command", "sessionOpen").put("path", File(root, "library.sqlite").absolutePath)
                    .put("workspace", workspace).put("replica", identity.readText())).getString("session")
                workspaceId=workspace
                native(JSONObject().put("command","sessionCommand").put("session",session).put("action","enableSyncConflicts").put("args",JSONObject()))
            }
        }
    }
    private fun native(request: JSONObject): JSONObject {
        request.put("version", 1)
        val response = JSONObject(NativeCore.execute(request.toString()))
        if (!response.getBoolean("ok")) throw IllegalStateException(response.getJSONObject("error").optString("code", "core_error"))
        val value = response.opt("value")
        return when (value) { is JSONObject -> value; is JSONArray -> JSONObject().put("items", value); else -> JSONObject().put("value", value) }
    }
    suspend fun command(action: String, args: JSONObject = JSONObject()): JSONObject = withContext(Dispatchers.IO) {
        native(JSONObject().put("command", "sessionCommand").put("session", session ?: error("书库尚未打开"))
            .put("action", action).put("args", args))
    }
    suspend fun list(kind: String): List<Record> {
        val result = mutableListOf<Record>(); var offset = 0
        do {
            val page = command("listPage", JSONObject().put("kind", kind).put("offset", offset).put("limit", 50))
            val items = page.getJSONArray("items")
            repeat(items.length()) { result += Record.from(items.getJSONObject(it)) }
            offset = if (page.isNull("nextOffset")) -1 else page.getInt("nextOffset")
        } while (offset >= 0)
        return result
    }
    suspend fun get(kind: String, id: String): Record = withContext(Dispatchers.IO) {
        val exported = command("exportEntity", JSONObject().put("kind", kind).put("id", id))
        val file = File(exported.getString("path"))
        try { Record.from(JSONObject(file.readText())) } finally { file.delete() }
    }
    suspend fun save(kind: String, prior: Record?, patch: JSONObject): Record = withContext(Dispatchers.IO) {
        val staged=File(root,"edit-${UUID.randomUUID()}.json")
        try {
            staged.writeText(JSONObject().put("kind",kind).put("id",prior?.id?:UUID.randomUUID().toString()).put("expected",prior?.revision?:0).put("patch",patch).toString())
            val result=File(command("saveFromFile",JSONObject().put("path",staged.absolutePath)).getString("path"))
            try {Record.from(JSONObject(result.readText()))}finally {result.delete()}
        } finally {staged.delete()}
    }
    suspend fun remove(kind: String, record: Record) = command("delete", JSONObject().put("kind", kind).put("id", record.id).put("expected", record.revision))
    suspend fun close() = withContext(Dispatchers.IO) { gate.withLock {
        session?.let { native(JSONObject().put("command", "sessionClose").put("session", it)) }; session = null
    } }
}
