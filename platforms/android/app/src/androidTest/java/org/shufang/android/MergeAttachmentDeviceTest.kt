package org.shufang.android

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class MergeAttachmentDeviceTest {
    private fun inkIdentity(book:String,page:Int)="pdfink."+java.security.MessageDigest.getInstance("SHA-256").digest(book.toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}+".$page"
    @Test fun jniMergeKeepsPdfInkAttachmentsAndReviewHistoryAcrossRetry():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName=="org.shufang.android.acceptance")
        val source=CoreRepository(context,"merge-test-${UUID.randomUUID()}")
        val target=CoreRepository(context,"merge-test-${UUID.randomUUID()}")
        try {
            source.open("offline");target.open("remote")
            val pdf=File(source.root,"test.pdf")
            val document=android.graphics.pdf.PdfDocument()
            try {val page=document.startPage(android.graphics.pdf.PdfDocument.PageInfo.Builder(595,842,1).create());page.canvas.drawText("Original PDF",40f,70f,android.graphics.Paint().apply {textSize=20f});document.finishPage(page);pdf.outputStream().use(document::writeTo)}finally{document.close()}
            val parsed=File(source.root,"parsed.json").apply {writeText(JSONObject().put("title","Merge acceptance").put("author","").put("format","pdf").put("pageCount",1).put("readerMode","original").put("chapters",JSONArray()).put("progress",JSONObject().put("chapterId","").put("ratio",0)).toString())}
            val book=Record.from(source.command("importParsed",JSONObject().put("path",pdf.path).put("parsedPath",parsed.path)))
            val ink=PortableInk(1000.0,1400.0,listOf(InkStroke("retained-stroke","pen",listOf(0.0,0.0,0.0,1.0),3.0,listOf(InkPoint(20.0,30.0,.8,0.0,0.0,0.0)))))
            val portable=File(source.root,"ink.json").apply {writeText(ink.json().toString())}
            val opaque=File(source.root,"pencil.bin").apply {writeBytes(byteArrayOf(0,-1,1,0,-2))}
            fun request(file:File,type:String)=JSONObject().put("path",file.path).put("name",file.name).put("type",type)
            val inkRef=source.command("putAttachment",request(portable,"application/json"))
            val legacyRef=source.command("putAttachment",request(opaque,"application/octet-stream"))
            val noteId=inkIdentity(book.id,1)
            source.command("save",JSONObject().put("kind","notes").put("id",noteId).put("expected",0).put("patch",JSONObject().put("title","页面手写").put("content","").put("bookId",book.id).put("pdfPage",1).put("pdfPortableInk",inkRef).put("pdfDrawing",legacyRef)))
            val quote=source.save("highlights",null,JSONObject().put("kind","pdf").put("bookId",book.id).put("text","Original PDF").put("pdfAnchor",JSONObject().put("page",1).put("rects",JSONArray().put(JSONObject().put("x",.1).put("y",.1).put("width",.3).put("height",.1)))))
            source.command("review",JSONObject().put("id",quote.id).put("rating",3).put("expected",quote.revision))
            val originalChanges=source.command("changes",JSONObject().put("after",0)).toString()
            val args=JSONObject().put("destination",target.root.path).put("workspace","remote").put("replica",File(target.root,"replica-id").readText()).put("batch","device-batch")
            source.command("mergeInto",args);source.command("mergeInto",args)
            val mapped=target.list("books").single()
            val note=target.get("notes",inkIdentity(mapped.id,1))
            assertEquals(mapped.id,note.text("bookId"))
            val actual=File(target.command("attachmentResource",JSONObject().put("reference",note.value.getJSONObject("pdfPortableInk"))).getString("path"))
            assertEquals(ink.json().toString(),actual.readText())
            val binary=File(target.command("attachmentResource",JSONObject().put("reference",note.value.getJSONObject("pdfDrawing"))).getString("path"))
            assertArrayEquals(opaque.readBytes(),binary.readBytes())
            assertArrayEquals(pdf.readBytes(),File(target.command("bookResource",JSONObject().put("id",mapped.id)).getString("path")).readBytes())
            val events=target.list("reviews");assertEquals(1,events.size)
            assertEquals(target.list("highlights").single().id,events.single().text("highlightId"))
            assertEquals(source.list("reviews").single().value.getJSONObject("state").toString(),events.single().value.getJSONObject("state").toString())
            assertEquals(originalChanges,source.command("changes",JSONObject().put("after",0)).toString())
            target.close();target.open("remote")
            assertEquals(1,target.list("notes").size);assertEquals(1,target.list("reviews").size)
        } finally {
            source.close();target.close()
            for(repo in listOf(source,target)){check(repo.root.canonicalFile.parentFile==File(context.filesDir,"workspaces").canonicalFile&&repo.key.startsWith("merge-test-"));repo.root.deleteRecursively()}
        }
    }
}
