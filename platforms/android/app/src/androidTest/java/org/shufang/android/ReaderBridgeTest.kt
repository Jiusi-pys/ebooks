package org.shufang.android

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ReaderBridgeTest {
    private fun diagnostics(view:DocumentWebView):String {
        val latch=CountDownLatch(1);var value="No JavaScript response"
        InstrumentationRegistry.getInstrumentation().runOnMainSync {view.evaluateJavascript("JSON.stringify({url:location.href,state:document.readyState,bridge:typeof ShufangBridge,legacy:typeof ShufangLegacyBridge,app:typeof window.shufang,body:document.body?document.body.innerText:'none'})"){value=it;latch.countDown()}}
        latch.await(10,TimeUnit.SECONDS);return value
    }

    @Test fun originalPdfBodyCanBeSearchedOfflineWithoutNativePdfium() {
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main);val ready=CountDownLatch(1);val done=CountDownLatch(1);val rendered=CountDownLatch(1);val exported=CountDownLatch(1);val rasterized=CountDownLatch(1);var exportPath="";var ocrPath=""
        val text="BT /F1 18 Tf 48 700 Td (Searchable offline PDF) Tj ET"
        val secondText="BT /F1 18 Tf 48 700 Td (Second page excerpt) Tj ET"
        val objects=listOf("<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>","<< /Length ${text.length} >>\nstream\n$text\nendstream","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>","<< /Length ${secondText.length} >>\nstream\n$secondText\nendstream")
        val output=StringBuilder("%PDF-1.4\n");val offsets=mutableListOf(0)
        objects.forEachIndexed {index,value->offsets.add(output.length);output.append("${index+1} 0 obj\n$value\nendobj\n")};val xref=output.length
        output.append("xref\n0 ${objects.size+1}\n0000000000 65535 f \n");offsets.drop(1).forEach {output.append("%010d 00000 n \n".format(it))};output.append("trailer\n<< /Size ${objects.size+1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF")
        val source=File(context.cacheDir,"search-${UUID.randomUUID()}.pdf").apply {writeText(output.toString())}
        lateinit var view:DocumentWebView;var hit=JSONObject();var outcome=JSONObject();var selection=JSONObject();val selected=CountDownLatch(1)
        instrumentation.runOnMainSync {view=DocumentWebView(context,scope){event->when(event.optString("type")){"ready"->ready.countDown();"fileEnd"->{if(event.optString("purpose")=="ocr"){ocrPath=event.getString("path");rasterized.countDown()}else {exportPath=event.getString("path");exported.countDown()}};"rendered"->rendered.countDown();"selection"->{selection=event.getJSONObject("anchor");selected.countDown()};"pdfSearchHit"->hit=event;"pdfSearchEnd"->{outcome=event;done.countDown()};"failure"->{outcome=event;done.countDown();rendered.countDown()}}};view.webChromeClient=object:android.webkit.WebChromeClient(){override fun onConsoleMessage(message:android.webkit.ConsoleMessage):Boolean {android.util.Log.e("ReaderTest",message.message()+" at "+message.lineNumber());return true}};view.layout(0,0,480,800)}
        try {
            val readyOk=ready.await(30,TimeUnit.SECONDS);assertTrue(diagnostics(view),readyOk)
            instrumentation.runOnMainSync {view.javascript("searchPdf",view.resource(source),"pdf-book","offline",7)}
            assertTrue(done.await(30,TimeUnit.SECONDS));assertTrue(outcome.toString(),hit.has("page"));assertEquals(1,hit.getInt("page"));assertEquals(7,hit.getInt("generation"));assertTrue(hit.getString("text").contains("offline"))
            val payload=File(context.cacheDir,"pdf-view-${UUID.randomUUID()}.json").apply {writeText(JSONObject().put("value",JSONObject().put("id","pdf-book").put("format","pdf").put("readerMode","original").put("title","Original PDF").put("chapters",JSONArray())).toString())}
            try {
                instrumentation.runOnMainSync {view.javascript("showBook",view.resource(payload,"application/json"),view.resource(source),"",JSONArray())}
                assertTrue("Original PDF render timed out: $outcome",rendered.await(30,TimeUnit.SECONDS))
                assertFalse(outcome.toString(),outcome.has("error"))
                val checked=CountDownLatch(1);var canvas=""
                instrumentation.runOnMainSync {view.evaluateJavascript("(document.querySelector('.pdf-page canvas')||{}).width",{canvas=it;checked.countDown()})}
                assertTrue(checked.await(10,TimeUnit.SECONDS));assertTrue(canvas,canvas.toIntOrNull()?.let {it>0}==true)
                val original=java.security.MessageDigest.getInstance("SHA-256").digest(source.readBytes())
                instrumentation.runOnMainSync {view.javascript("ocrPage")}
                val rasterOk=rasterized.await(30,TimeUnit.SECONDS);assertTrue("PDF rasterization did not finish: $outcome",rasterOk)
                try {val recognized=runBlocking {withTimeout(60_000){PageOcr.recognize(File(ocrPath))}};if(!recognized.contains("offline",ignoreCase=true)){File(context.getExternalFilesDir(null),"ocr-failure.png").writeBytes(File(ocrPath).readBytes());var zoom=0;instrumentation.runOnMainSync {zoom=view.settings.textZoom};File(context.getExternalFilesDir(null),"ocr-failure.txt").writeText("zoom=$zoom; fontScale=${context.resources.configuration.fontScale}; text=$recognized")};assertTrue(recognized,recognized.contains("offline",ignoreCase=true))}finally {File(ocrPath).delete()}
                val ink=PortableInk(1000.0,1400.0,listOf(InkStroke("dot","pen",listOf(0.0,0.0,0.0,1.0),10.0,listOf(InkPoint(100.0,100.0,1.0,0.0,0.0,0.0))),InkStroke("stroke","pen",listOf(0.0,0.0,0.0,1.0),3.0,listOf(InkPoint(300.0,300.0,1.0,0.0,0.0,0.0),InkPoint(400.0,400.0,1.0,0.0,0.0,1.0)))))
                instrumentation.runOnMainSync {view.javascript("exportPdf",JSONArray().put(JSONObject().put("page",1).put("ink",ink.json())))}
                assertTrue("PDF export did not finish: $outcome",exported.await(30,TimeUnit.SECONDS))
                try {
                    assertTrue(File(exportPath).readBytes().take(4).toByteArray().contentEquals("%PDF".toByteArray()));assertFalse(source.readBytes().contentEquals(File(exportPath).readBytes()));assertArrayEquals(original,java.security.MessageDigest.getInstance("SHA-256").digest(source.readBytes()))
                    fun raster(file:File):android.graphics.Bitmap {
                        val bitmap=android.graphics.Bitmap.createBitmap(595,842,android.graphics.Bitmap.Config.ARGB_8888)
                        bitmap.eraseColor(android.graphics.Color.WHITE)
                        android.graphics.pdf.PdfRenderer(android.os.ParcelFileDescriptor.open(file,android.os.ParcelFileDescriptor.MODE_READ_ONLY)).use {renderer->renderer.openPage(0).use {page->page.render(bitmap,null,null,android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)}}
                        return bitmap
                    }
                    val before=raster(source);val after=raster(File(exportPath))
                    try {assertEquals(android.graphics.Color.WHITE,before.getPixel(59,60));assertTrue("Exported single point is absent from its page position",android.graphics.Color.red(after.getPixel(59,60))<100)}finally {before.recycle();after.recycle()}
                }finally {File(exportPath).delete()}


                instrumentation.runOnMainSync {view.javascript("pdfPage",2)}
                val selectedPageReady=CountDownLatch(1)
                instrumentation.runOnMainSync {view.evaluateJavascript("(()=>{let tries=0;const timer=setInterval(()=>{const p=document.querySelector('.pdf-page[data-page=\"2\"] .textLayer span');if(!p||!p.firstChild){if(++tries>100)clearInterval(timer);return;}clearInterval(timer);const range=document.createRange();range.selectNodeContents(p);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));},100);return true;})()",{selectedPageReady.countDown()})}
                assertTrue(selectedPageReady.await(10,TimeUnit.SECONDS));assertTrue("Second page selection timed out",selected.await(20,TimeUnit.SECONDS))
                assertEquals(2,selection.getJSONObject("pdfAnchor").getInt("page"));assertTrue(selection.getString("text").contains("Second page"))
                val styled=CountDownLatch(1);var textStyle=""
                instrumentation.runOnMainSync {view.evaluateJavascript("(()=>{const s=getComputedStyle(document.querySelector('.textLayer span'));return s.position+'|'+s.color;})()",{textStyle=it;styled.countDown()})}
                assertTrue(styled.await(10,TimeUnit.SECONDS));assertTrue("PDF text layer must not duplicate canvas text: $textStyle",textStyle.contains("absolute|rgba(0, 0, 0, 0)"))

            }finally {payload.delete()}
        }finally {instrumentation.runOnMainSync {view.destroy()};scope.cancel();source.delete()}
    }
    @Test fun actualReaderSelectionKeepsWebUtf16OffsetsAndPackagedFootnotes() {
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main)
        val ready=CountDownLatch(1);val rendered=CountDownLatch(1);val selected=CountDownLatch(1)
        var anchor=JSONObject();lateinit var view:DocumentWebView
        val book=JSONObject().put("id","reader-test").put("title","Reader").put("format","txt").put("readerMode","reflow")
            .put("chapters",JSONArray().put(JSONObject().put("id","chapter").put("title","第一章").put("paragraphs",JSONArray().put("正文 🚀 abc")).put("footnotes",JSONArray().put(JSONObject().put("paraIndex",0).put("start",3).put("end",5).put("content","火箭注释")))))
        val payload=File(context.cacheDir,"reader-test-${UUID.randomUUID()}.json").apply {writeText(JSONObject().put("value",book).toString())}
        instrumentation.runOnMainSync {view=DocumentWebView(context,scope){event->when(event.optString("type")){"ready"->ready.countDown();"rendered"->rendered.countDown();"selection"->{anchor=event.getJSONObject("anchor");selected.countDown()}}};view.webChromeClient=object:android.webkit.WebChromeClient(){override fun onConsoleMessage(message:android.webkit.ConsoleMessage):Boolean {android.util.Log.e("ReaderTest",message.message()+" at "+message.lineNumber());return true}};view.layout(0,0,480,800)}
        try {
            val readyOk=ready.await(30,TimeUnit.SECONDS);assertTrue(diagnostics(view),readyOk)
            instrumentation.runOnMainSync {view.javascript("showBook",view.resource(payload,"application/json"),"","chapter",JSONArray())}
            assertTrue(rendered.await(30,TimeUnit.SECONDS))
            instrumentation.runOnMainSync {view.evaluateJavascript("(()=>{const p=document.querySelector('p[data-index]');const r=document.createRange();const node=p.querySelector('.footnote').firstChild;r.setStart(node,0);r.setEnd(node,2);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));})()",null)}
            assertTrue(selected.await(10,TimeUnit.SECONDS));assertEquals("🚀",anchor.getString("text"));assertEquals(3,anchor.getInt("start"));assertEquals(5,anchor.getInt("end"))
            val checked=CountDownLatch(1);var notes=""
            instrumentation.runOnMainSync {view.evaluateJavascript("(()=>{getSelection().removeAllRanges();document.querySelector('.footnote').click();return (document.querySelector('.footnote-popup')||{}).textContent;})()",{notes=it;checked.countDown()})}
            assertTrue(checked.await(10,TimeUnit.SECONDS));assertTrue(notes,notes.contains("火箭注释"))
            val translated=CountDownLatch(1);var parallel=""
            instrumentation.runOnMainSync {view.javascript("showTranslation","译文示例");view.evaluateJavascript("(document.querySelector('.bilingual-view')||{}).textContent",{parallel=it;translated.countDown()})}
            assertTrue(translated.await(10,TimeUnit.SECONDS));assertTrue(parallel,parallel.contains("正文")&&parallel.contains("译文示例"))
        }finally {instrumentation.runOnMainSync {view.destroy()};scope.cancel();payload.delete()}
    }
}
