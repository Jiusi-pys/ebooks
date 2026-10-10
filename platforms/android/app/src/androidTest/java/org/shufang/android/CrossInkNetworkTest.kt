package org.shufang.android

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.UUID

/** Explicitly gated: uses only the isolated loopback server and generated records. */
class CrossInkNetworkTest {
    @Test fun androidRestoresIosZIPWithOriginalAndInk():Unit=runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("crossInkStep")=="restore")
        val context=InstrumentationRegistry.getInstrumentation().targetContext;check(context.packageName=="org.shufang.android.acceptance")
        val metadata=JSONObject(File(context.getExternalFilesDir(null),"cross-ink-network.json").readText())
        val repo=CoreRepository(context,"ios-zip-restore-${UUID.randomUUID()}");repo.open("android-fixture")
        try {
            val source=File(context.getExternalFilesDir(null),"ios-return-study.zip")
            val preview=repo.command("previewStudyRestore",JSONObject().put("path",source.path).put("origin","http://127.0.0.1:31487").put("userID","ink-network-acceptance").put("policy","replace"))
            repo.command("commitStudyRestore",preview)
            assertEquals(metadata.getString("bookId"),repo.get("books",metadata.getString("bookId")).id)
            val note=repo.get("notes",metadata.getString("noteId"));val reference=note.value.getJSONObject("pdfPortableInk")
            val ink=File(repo.command("attachmentResource",JSONObject().put("reference",reference)).getString("path"))
            assertEquals(1,PortableInk.decode(JSONObject(ink.readText())).strokes.size)
            assertEquals(1,repo.list("reviews").filter {it.text("highlightId")==metadata.getString("cardId")}.size)
            val original=File(repo.command("bookResource",JSONObject().put("id",metadata.getString("bookId"))).getString("path"))
            assertEquals(metadata.getString("originalSha256"),java.security.MessageDigest.getInstance("SHA-256").digest(original.readBytes()).joinToString(""){"%02x".format(it)})
        }finally{repo.close()}
    }
    private suspend fun sync(repo:CoreRepository) {
        val start=repo.command("syncOnce",JSONObject().put("id","fixture-server").put("url","http://127.0.0.1:31487").put("token","android-public-machine-token"))
        withTimeout(60000){while(true){val result=repo.command("job",JSONObject().put("id",start.getString("job")));when(result.getString("status")){"completed"->return@withTimeout;"failed","cancelled"->error(result.toString())};delay(100)}}
    }
    @Test fun androidPublishesEditableInkThroughRealServer():Unit=runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("crossInkStep")=="publish")
        val context=InstrumentationRegistry.getInstrumentation().targetContext;check(context.packageName=="org.shufang.android.acceptance")
        val key="cross-ink-${UUID.randomUUID()}";val repo=CoreRepository(context,key);repo.open("android-fixture")
        try {val source=File(repo.root,"original.pdf");val pdf=android.graphics.pdf.PdfDocument();try {val page=pdf.startPage(android.graphics.pdf.PdfDocument.PageInfo.Builder(595,842,1).create());page.canvas.drawText("Cross platform ink",40f,70f,android.graphics.Paint().apply{textSize=20f});pdf.finishPage(page);source.outputStream().use(pdf::writeTo)}finally{pdf.close()}
            val parsed=File(repo.root,"parsed.json").apply {writeText(JSONObject().put("title","Cross ink acceptance").put("author","").put("format","pdf").put("readerMode","original").put("pageCount",1).put("coverTone",0).put("chapters",JSONArray()).put("progress",JSONObject().put("chapterId","").put("ratio",0)).toString())}
            val book=Record.from(repo.command("importParsed",JSONObject().put("path",source.path).put("parsedPath",parsed.path)))
            val ink=PortableInk(1000.0,1400.0,listOf(InkStroke("android-network-stroke","pen",listOf(0.0,0.0,0.0,1.0),3.0,listOf(InkPoint(20.0,30.0,.8,0.0,0.0,0.0),InkPoint(120.0,180.0,.9,0.0,0.0,1.0)))))
            val model=LibraryViewModel(context.applicationContext as android.app.Application)
            model.loadInk(repo,book.id,1);model.saveInk(repo,book.id,1,ink).join()
            val id="pdfink."+java.security.MessageDigest.getInstance("SHA-256").digest(book.id.toByteArray()).joinToString(""){"%02x".format(it)}+".1"
            assertTrue(model.state.value.error,repo.get("notes",id).value.has("pdfPortableInk"))
            val card=repo.save("highlights",null,JSONObject().put("kind","pdf").put("bookId",book.id).put("chapterId","").put("chapterTitle","第 1 页").put("text","Cross platform ink").put("pdfAnchor",JSONObject().put("page",1).put("rects",JSONArray().put(JSONObject().put("x",.1).put("y",.1).put("width",.3).put("height",.1)))))
            repo.command("review",JSONObject().put("id",card.id).put("expected",card.revision).put("rating",3))
            sync(repo)
            val zip=File(repo.root,"cross-study.zip");repo.command("exportStudyBackup",JSONObject().put("path",zip.path).put("origin","http://127.0.0.1:31487").put("userID","ink-network-acceptance"))
            zip.copyTo(File(context.getExternalFilesDir(null),"cross-study.zip"),overwrite=true)
            File(context.getExternalFilesDir(null),"cross-ink-network.json").writeText(JSONObject().put("repositoryKey",key).put("bookId",book.id).put("noteId",id).put("cardId",card.id).put("originalSha256",java.security.MessageDigest.getInstance("SHA-256").digest(source.readBytes()).joinToString(""){"%02x".format(it)}).toString())
        }finally{repo.close()}
    }
    @Test fun androidReceivesIosEditingAndContinuesDrawing():Unit=runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("crossInkStep")=="receive")
        val context=InstrumentationRegistry.getInstrumentation().targetContext;check(context.packageName=="org.shufang.android.acceptance")
        val metadata=JSONObject(File(context.getExternalFilesDir(null),"cross-ink-network.json").readText())
        val repo=CoreRepository(context,metadata.getString("repositoryKey"));repo.open("android-fixture")
        try {sync(repo);val note=repo.get("notes",metadata.getString("noteId"));assertTrue(note.value.has("pdfDrawing"))
            val file=File(repo.command("attachmentResource",JSONObject().put("reference",note.value.getJSONObject("pdfPortableInk"))).getString("path"));val ink=PortableInk.decode(JSONObject(file.readText()));assertEquals(2,ink.strokes.size);assertEquals("android-network-stroke",ink.strokes.first().id)
            val model=LibraryViewModel(context.applicationContext as android.app.Application);assertEquals(2,model.loadInk(repo,metadata.getString("bookId"),1)!!.strokes.size)
            val continued=ink.copy(strokes=ink.strokes+InkStroke("android-return-stroke","pen",listOf(0.0,0.0,0.0,1.0),3.0,listOf(InkPoint(500.0,500.0,1.0,0.0,0.0,0.0))))
            model.saveInk(repo,metadata.getString("bookId"),1,continued).join();sync(repo)
            val original=File(repo.command("bookResource",JSONObject().put("id",metadata.getString("bookId"))).getString("path"));assertEquals(metadata.getString("originalSha256"),java.security.MessageDigest.getInstance("SHA-256").digest(original.readBytes()).joinToString(""){"%02x".format(it)})
            assertTrue(repo.list("notes").any {it.text("title")=="iOS network business acceptance"})
            assertEquals("真实浏览器修改😀",repo.get("notes",metadata.getString("webNoteId")).text("content"))
            assertFalse(repo.list("notes").any {it.id==metadata.getString("webDeletedNoteId")})
            assertEquals(2,repo.list("reviews").filter {it.text("highlightId")==metadata.getString("cardId")}.size)
            val review=repo.get("highlights",metadata.getString("cardId")).value.getJSONObject("review");assertEquals(4,review.getInt("lastRating"));assertEquals(2,review.getInt("reps"))
        }finally{repo.close()}
    }
}
