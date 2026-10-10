package org.shufang.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.Socket
import java.util.UUID
import java.io.File
import androidx.compose.ui.test.*
import androidx.compose.ui.graphics.asAndroidBitmap

/** Runs against the real Rust fixture server over adb reverse, never production. */
@RunWith(AndroidJUnit4::class)
class AndroidSyncTest {
    @get:org.junit.Rule val compose=androidx.compose.ui.test.junit4.createEmptyComposeRule()
    @Test fun twoOfflineClientsExposePersistentConflictAndTouchChoiceSynchronizes():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val preferences=context.getSharedPreferences("android-ui",0)
        val prior=preferences.all.toMap();val root="conflict-touch-${UUID.randomUUID()}"
        preferences.edit().clear().putString("origin","http://127.0.0.1:31487").putString("account","fixture-server").putString("authMode","node").putString("workspace","android-fixture").putString("rootKey",root).putBoolean("autoSync",false).commit()
        val scenario=androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java)
        lateinit var model:LibraryViewModel
        scenario.onActivity {model=androidx.lifecycle.ViewModelProvider(it)[LibraryViewModel::class.java]}
        compose.waitUntil(20000){model.state.value.ready}
        val a=model.repository;val b=CoreRepository(context,"conflict-other-${UUID.randomUUID()}");b.open("android-fixture")
        try {
            val seed=a.save("notes",null,JSONObject().put("title","Concurrent fixture").put("content","base"))
            assertEquals("completed",sync(a,"android-public-machine-token",true).getString("status"))
            assertEquals("completed",sync(b,"android-public-machine-token",true).getString("status"))
            a.save("notes",a.get("notes",seed.id),JSONObject().put("content","my offline version"))
            b.save("notes",b.get("notes",seed.id),JSONObject().put("content","other offline version"))
            assertEquals("completed",sync(b,"android-public-machine-token",true).getString("status"))
            val failed=sync(a,"android-public-machine-token",true);assertEquals("sync_conflicts_pending",failed.getString("error"))
            model.reload();assertEquals(1,model.state.value.syncConflicts.size)
            model.previewSyncConflict(model.state.value.syncConflicts.first().getString("id")).join()
            compose.onNodeWithText("my offline version").assertIsDisplayed()
            compose.onNodeWithText("other offline version").performScrollTo().assertIsDisplayed()
            if(android.os.Build.VERSION.SDK_INT>=28){
                val screenshot=compose.onNode(isDialog()).captureToImage().asAndroidBitmap()
                File(context.getExternalFilesDir(null),"offline-conflict.png").outputStream().use {screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
            }
            compose.onNodeWithText("稍后处理").performClick()
            compose.waitUntil(10000){model.state.value.syncConflictPreview==null}
            val restarted=CoreRepository(context,root);restarted.open("android-fixture")
            try {assertEquals(1,restarted.command("syncConflicts").getJSONArray("items").length())}finally {restarted.close()}
            model.previewSyncConflict(model.state.value.syncConflicts.first().getString("id")).join()
            compose.onNodeWithText("保留双方副本").performClick()
            compose.waitUntil(10000){model.state.value.syncConflictPreview==null&&model.state.value.busy.isEmpty()}
            assertTrue(model.state.value.error.isEmpty())
            assertEquals("completed",sync(a,"android-public-machine-token",true).getString("status"))
            assertEquals("completed",sync(b,"android-public-machine-token",true).getString("status"))
            val copies=b.list("notes").filter {it.text("title")=="Concurrent fixture"}
            assertEquals(2,copies.size);assertEquals(setOf("my offline version","other offline version"),copies.map {it.text("content")}.toSet())
            assertEquals(0,a.command("syncConflicts").getJSONArray("items").length())
        }finally {
            b.close();scenario.close()
            val editor=preferences.edit().clear();for((key,value)in prior)when(value){is String->editor.putString(key,value);is Boolean->editor.putBoolean(key,value);is Int->editor.putInt(key,value);is Long->editor.putLong(key,value);is Float->editor.putFloat(key,value)};editor.commit()
        }
    }
    private data class Response(val status:Int,val cookie:String,val text:String)
    private suspend fun http(path:String,body:JSONObject?=null,cookie:String="",method:String=if(body==null)"GET"else "POST"):Response=withContext(Dispatchers.IO) {
        Socket("127.0.0.1",31487).use {socket->
            socket.soTimeout=30_000
            val data=body?.toString()?.toByteArray(Charsets.UTF_8)?:byteArrayOf()
            val headers="$method $path HTTP/1.1\r\nHost: 127.0.0.1:31487\r\nOrigin: http://127.0.0.1:31487\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${data.size}\r\n${if(cookie.isBlank())""else "Cookie: $cookie\r\n"}\r\n"
            socket.getOutputStream().apply {write(headers.toByteArray(Charsets.US_ASCII));write(data);flush()}
            val raw=socket.getInputStream().readBytes().toString(Charsets.UTF_8);val head=raw.substringBefore("\r\n\r\n")
            Response(head.substringBefore("\r\n").split(' ')[1].toInt(),head.lines().firstOrNull {it.startsWith("set-cookie:",true)}?.substringAfter(':')?.trim()?.substringBefore(';').orEmpty(),raw.substringAfter("\r\n\r\n"))
        }
    }
    private suspend fun sync(repository:CoreRepository,credential:String,node:Boolean=false):JSONObject {
        val args=JSONObject().put("id","fixture-server").put("url","http://127.0.0.1:31487").put("token",if(node)credential else "")
        if(!node)args.put("cookie",credential)
        val started=repository.command("syncOnce",args);val id=started.getString("job")
        return withTimeout(60_000) {while(true) {
            val status=repository.command("job",JSONObject().put("id",id))
            if(status.getString("status") in listOf("completed","failed","cancelled"))return@withTimeout status
            delay(100)
        };@Suppress("UNREACHABLE_CODE") JSONObject()}
    }
    @Test fun deviceAccountSyncPreservesOfflineEditsAndNodeAuthIsIndependent()=runBlocking {
        val login=http("/api/auth/login",JSONObject().put("appId","bootstrap").put("appSecret","bootstrap-secret"))
        assertEquals(200,login.status)
        val setup=http("/api/auth/setup",JSONObject().put("username","android-fixture-user").put("newPassword","public-test-password-123").put("confirmPassword","public-test-password-123"),login.cookie)
        assertEquals(200,setup.status);assertTrue(setup.cookie.startsWith("shufang_session="))
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val repository=CoreRepository(context,"http-sync-${UUID.randomUUID()}");repository.open("android-fixture")
        try {
            val saved=repository.save("notes",null,JSONObject().put("title","Android 离线同步").put("content","来自真实 JNI 🚀"))
            val original=File(repository.root,"transfer.txt").apply {writeText("双向原文件 🚀")}
            val parsed=File(repository.root,"transfer.json").apply {writeText("""{"title":"同步原文件","author":"测试","format":"txt","coverTone":0,"chapters":[{"id":"transfer-chapter","title":"章节","paragraphs":["双向原文件 🚀"]}],"progress":{"chapterId":"transfer-chapter","ratio":0}}""")}
            val book=Record.from(repository.command("importParsed",JSONObject().put("path",original.path).put("parsedPath",parsed.path)))
            assertEquals("completed",sync(repository,setup.cookie).getString("status"))
            assertEquals("服务端原数据 🚀",repository.get("notes","server-seed").text("content"))
            val received=JSONArray(http("/fixture/notes").text)
            assertTrue((0 until received.length()).any {received.getJSONObject(it).getJSONObject("value").optString("id")==saved.id})
            val receiver=CoreRepository(context,"http-receiver-${UUID.randomUUID()}");receiver.open("android-fixture")
            try {
                assertEquals("completed",sync(receiver,setup.cookie).getString("status"))
                val file=receiver.command("bookResource",JSONObject().put("id",book.id))
                assertEquals("双向原文件 🚀",File(file.getString("path")).readText())
                receiver.command("removeDownload",JSONObject().put("id",book.id))
                assertFalse(File(file.getString("path")).exists())
                assertEquals("completed",sync(receiver,setup.cookie).getString("status"))
                assertFalse(receiver.command("downloadState",JSONObject().put("id",book.id)).getBoolean("enabled"))
                assertFalse("Automatic sync downloaded an explicitly removed file",File(file.getString("path")).exists())
                assertEquals(book.id,receiver.get("books",book.id).id)
                receiver.command("enableDownload",JSONObject().put("id",book.id))
                assertEquals("completed",sync(receiver,setup.cookie).getString("status"))
                assertEquals("双向原文件 🚀",File(receiver.command("bookResource",JSONObject().put("id",book.id)).getString("path")).readText())
            }finally {receiver.close()}
            val seed=repository.get("notes","server-seed");repository.remove("notes",seed)
            assertEquals("completed",sync(repository,setup.cookie).getString("status"))
            val after=JSONArray(http("/fixture/notes").text);assertFalse((0 until after.length()).any {after.getJSONObject(it).getJSONObject("value").optString("id")=="server-seed"})
            repository.save("notes",saved,JSONObject().put("content","认证失效时的待同步编辑"))
            val profile=http("/api/auth/profile",JSONObject().put("username","android-fixture-user").put("currentPassword","public-test-password-123").put("newPassword","public-test-password-456").put("confirmPassword","public-test-password-456"),setup.cookie,"PATCH")
            assertEquals(200,profile.status)
            assertEquals("failed",sync(repository,setup.cookie).getString("status"))
            assertEquals("认证失效时的待同步编辑",repository.get("notes",saved.id).text("content"))
            assertEquals("failed",sync(repository,"invalid-node-token",true).getString("status"))
            assertEquals("completed",sync(repository,"android-public-machine-token",true).getString("status"))
            assertEquals("completed",sync(repository,profile.cookie).getString("status"))
        }finally {repository.close()}
    }
}
