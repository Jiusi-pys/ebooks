package org.shufang.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NativeContractTest {
    @Test fun isolatedUtf16SurrogateIsRejectedBeforeTheBridge() {
        assertTrue(runCatching {shufang.core.NativeCore.execute("\uD800")}.exceptionOrNull() is IllegalArgumentException)
    }
    @Test fun actualJniPersistsUnicodeAndRejectsStaleRevision() = runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val repository=CoreRepository(context,"test-${UUID.randomUUID()}")
        repository.open("instrumentation")
        val saved=repository.save("notes",null,JSONObject().put("title","设备测试 🚀").put("content","中文、𠮷和 emoji 🌱"))
        val updated=repository.save("notes",saved,JSONObject().put("content","更新后的正文"))
        assertTrue(runCatching {repository.save("notes",saved,JSONObject().put("content","旧版本不应覆盖"))}.isFailure)
        assertEquals("更新后的正文",repository.get("notes",saved.id).text("content"))
        repository.close();repository.open("instrumentation")
        assertEquals(updated.revision,repository.get("notes",saved.id).revision)
        assertEquals("设备测试 🚀",repository.get("notes",saved.id).text("title"))
        repository.close()
    }
    @Test fun actualJniImportsAndReadsOriginalFile() = runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val repository=CoreRepository(context,"import-test-${UUID.randomUUID()}");repository.open("instrumentation")
        val file=File(repository.root,"样例.txt").apply {writeText("Android 离线正文 🚀")}
        val parsed=File(repository.root,"parsed.json").apply {writeText("""{"title":"离线书籍","author":"作者","format":"txt","coverTone":0,"chapters":[{"id":"chapter","title":"第一章","paragraphs":["Android 离线正文 🚀"]}],"progress":{"chapterId":"chapter","ratio":0}}""")}
        val imported=Record.from(repository.command("importParsed",JSONObject().put("path",file.absolutePath).put("parsedPath",parsed.absolutePath)))
        val resource=repository.command("bookResource",JSONObject().put("id",imported.id))
        assertEquals("Android 离线正文 🚀",File(resource.getString("path")).readText())
        repository.close();repository.open("instrumentation")
        assertEquals("Android 离线正文 🚀",repository.get("books",imported.id).value.getJSONArray("chapters").getJSONObject(0).getJSONArray("paragraphs").getString(0))
        repository.close()
    }
    @Test fun keystoreCiphertextsSurviveAndAreBoundToCredentialName() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val vault=SecretVault(context);val name="test-${UUID.randomUUID()}"
        vault.put(name,"secret 🚀");assertEquals("secret 🚀",SecretVault(context).get(name));vault.remove(name);assertNull(vault.get(name))
    }
}
