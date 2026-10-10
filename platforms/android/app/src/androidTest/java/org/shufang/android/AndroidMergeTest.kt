package org.shufang.android

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import java.io.File

class AndroidMergeTest {
    @Test fun actualJniWholeMergeKeepsSourceHistoryAndRetriesWithStableReferences():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val source=CoreRepository(context,"merge-source-${UUID.randomUUID()}");source.open("source")
        val target=CoreRepository(context,"merge-target-${UUID.randomUUID()}");target.open("target")
        try {
            source.command("save",JSONObject("""{"kind":"notes","id":"collision","expected":0,"patch":{"title":"本地笔记","content":"正文"}}"""))
            target.command("save",JSONObject("""{"kind":"notes","id":"collision","expected":0,"patch":{"title":"服务器笔记","content":"原数据"}}"""))
            val original=File(source.root,"source.txt").apply {writeText("正文 🚀")}
            val parsed=File(source.root,"parsed.json").apply {writeText("""{"title":"合并书籍","author":"作者","format":"txt","coverTone":0,"chapters":[{"id":"chapter","title":"章节","paragraphs":["正文 🚀"]}],"progress":{"chapterId":"chapter","ratio":0}}""")}
            val book=Record.from(source.command("importParsed",JSONObject().put("path",original.path).put("parsedPath",parsed.path)))
            val quote=source.save("highlights",null,JSONObject().put("bookId",book.id).put("chapterId","chapter").put("paraIndex",0).put("start",0).put("end",2).put("text","正文"))
            source.command("cite",JSONObject().put("highlight",quote.id).put("note","collision").put("highlightRevision",quote.revision).put("noteRevision",1))
            val before=source.command("changes",JSONObject().put("after",0)).toString()
            val args=JSONObject().put("destination",target.root.path).put("workspace","target").put("replica",File(target.root,"replica-id").readText()).put("batch","confirmed-device-batch")
            assertTrue(source.command("mergeInto",args).getBoolean("completed"))
            assertTrue(source.command("mergeInto",args).getBoolean("completed"))
            assertEquals(before,source.command("changes",JSONObject().put("after",0)).toString())
            assertEquals(2,target.list("notes").size)
            assertEquals("原数据",target.get("notes","collision").text("content"))
            val mergedBook=target.list("books").single();assertNotEquals(book.id,mergedBook.id)
            val mergedQuote=target.list("highlights").single();assertEquals(mergedBook.id,mergedQuote.text("bookId"))
            assertEquals("本地笔记",target.get("notes",mergedQuote.text("noteId")).text("title"))
            val resource=target.command("bookResource",JSONObject().put("id",mergedBook.id))
            assertEquals("正文 🚀",File(resource.getString("path")).readText())
        }finally {source.close();target.close()}
    }
}
