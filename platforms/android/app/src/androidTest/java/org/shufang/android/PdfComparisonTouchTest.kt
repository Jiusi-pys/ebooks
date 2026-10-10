package org.shufang.android

import androidx.test.core.app.ActivityScenario
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.ViewModelProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PdfComparisonTouchTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun twoPdfViewsKeepIndependentPositionsAndSynchronizeFingerScrolling():Unit=runBlocking {
        val ins=InstrumentationRegistry.getInstrumentation();val context=ins.targetContext
        check(context.packageName=="org.shufang.android.acceptance")
        val repo=CoreRepository(context);repo.open();val books=mutableListOf<Record>();val files=mutableListOf<File>();val suffix=UUID.randomUUID().toString()
        for(number in 1..2){val source=File(context.cacheDir,"comparison-$suffix-$number.pdf");files+=source
            val pdf=android.graphics.pdf.PdfDocument();try {for(p in 1..4){val page=pdf.startPage(android.graphics.pdf.PdfDocument.PageInfo.Builder(595,842,p).create());page.canvas.drawText("Comparison $number Page $p",30f,70f,android.graphics.Paint().apply {textSize=24f});pdf.finishPage(page)};source.outputStream().use(pdf::writeTo)}finally{pdf.close()}
            val parsed=File(context.cacheDir,"comparison-$suffix-$number.json").apply {writeText(JSONObject().put("title","对照验收 $number $suffix").put("author","").put("format","pdf").put("readerMode","original").put("pageCount",4).put("chapters",JSONArray()).put("progress",JSONObject().put("chapterId","").put("ratio",0)).toString())};files+=parsed
            books+=Record.from(repo.command("importParsed",JSONObject().put("path",source.path).put("parsedPath",parsed.path)))
        }
        val scenario=ActivityScenario.launch(MainActivity::class.java);var display=0;var model:LibraryViewModel?=null
        val requestedOrientation=if(InstrumentationRegistry.getArguments().getString("orientation")=="landscape") android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        scenario.onActivity {display=it.windowManager.defaultDisplay.displayId;model=ViewModelProvider(it)[LibraryViewModel::class.java];it.requestedOrientation=requestedOrientation}
        fun shell(command:String)=ins.uiAutomation.executeShellCommand(command).use {android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText()}
        val oldSize=shell("wm size -d $display");val oldDensity=shell("wm density -d $display")
        fun views():List<DocumentWebView>{val list=mutableListOf<DocumentWebView>();scenario.onActivity {a->fun visit(v:android.view.View){if(v is DocumentWebView)list+=v else if(v is android.view.ViewGroup)for(i in 0 until v.childCount)visit(v.getChildAt(i))};visit(a.window.decorView)};return list}
        fun js(v:DocumentWebView,code:String):String {val latch=CountDownLatch(1);var value="";ins.runOnMainSync {v.evaluateJavascript(code){value=it;latch.countDown()}};assertTrue(latch.await(10,TimeUnit.SECONDS));return value}
        fun position(v:DocumentWebView)=JSONObject(JSONArray("["+js(v,"JSON.stringify({page:Number(document.querySelector('#status').textContent.split('/')[0].trim()),fraction:(()=>{const c=document.querySelector('#content'),p=Array.from(document.querySelectorAll('.pdf-page')).find(p=>Number(p.dataset.page)===Number(document.querySelector('#status').textContent.split('/')[0].trim()));return p?Math.max(0,-(p.getBoundingClientRect().top-c.getBoundingClientRect().top)/p.getBoundingClientRect().height):0})()})")+"]").getString(0))
        try {
            InstrumentationRegistry.getArguments().getString("windowWidthDp")?.toInt()?.let {w->shell("wm density 160 -d $display");shell("wm size ${w}x1280 -d $display");compose.waitUntil(10000){var actual=0;scenario.onActivity {actual=it.resources.configuration.screenWidthDp};actual==w}}
            compose.waitUntil(20000){model?.state?.value?.ready==true};model!!.openBook(books[0].id).join()
            compose.waitUntil(20000){views().isNotEmpty()};compose.onNodeWithContentDescription("更多阅读工具").performScrollTo().performClick();compose.onNodeWithText("双文档对照").performScrollTo().performClick()
            compose.onNodeWithText("选择第二份 PDF").performClick();compose.onNodeWithText(books[1].text("title")).performScrollTo().performClick()
            compose.waitUntil(45000){val vs=views();vs.size==2&&vs.all {js(it,"!!document.querySelector('.pdf-page canvas')")=="true"}}
            val vs=views();ins.runOnMainSync {vs[0].javascript("pdfPosition",2,.25,"acceptance-command")}
            compose.waitUntil(10000){position(vs[0]).optInt("page")==2};assertEquals(1,position(vs[1]).getInt("page"))
            compose.onNodeWithText("同步滚动").performClick()
            val xy=IntArray(2);var height=0;var width=0;ins.runOnMainSync {vs[0].getLocationOnScreen(xy);height=vs[0].height;width=vs[0].width}
            val displayOption=if(android.os.Build.VERSION.SDK_INT>=29)"-d $display "else ""
            shell("input ${displayOption}swipe ${xy[0]+width/2} ${xy[1]+height*3/4} ${xy[0]+width/2} ${xy[1]+height/4} 350")
            compose.waitUntil(15000){val a=position(vs[0]);val b=position(vs[1]);a.getInt("page")==b.getInt("page")&&kotlin.math.abs(a.getDouble("fraction")-b.getDouble("fraction"))<.08}
            // A real finger swipe can keep flinging after the command returns.
            // Compare the settled anchors, including during screenshot capture.
            var lastPosition="";var stableSince=android.os.SystemClock.elapsedRealtime()
            compose.waitUntil(10000){val current=position(vs[0]).toString()+position(vs[1]).toString();val now=android.os.SystemClock.elapsedRealtime();if(current!=lastPosition){lastPosition=current;stableSince=now};now-stableSince>=600}
            val a=position(vs[0]);val b=position(vs[1]);assertTrue("Finger gesture did not change the initiator",a.getInt("page")!=2||kotlin.math.abs(a.getDouble("fraction")-.25)>.03)
            val evidence=JSONObject().put("first",a).put("second",b).put("viewCount",vs.size)
            compose.waitForIdle()
            val captured=CountDownLatch(1);var captureResult=-1
            scenario.onActivity {activity->
                evidence.put("widthDp",activity.resources.configuration.screenWidthDp).put("heightDp",activity.resources.configuration.screenHeightDp).put("densityDpi",activity.resources.displayMetrics.densityDpi).put("fontScale",activity.resources.configuration.fontScale)
                val bitmap=android.graphics.Bitmap.createBitmap(activity.window.decorView.width,activity.window.decorView.height,android.graphics.Bitmap.Config.ARGB_8888)
                android.view.PixelCopy.request(activity.window,bitmap,{result->captureResult=result;if(result==android.view.PixelCopy.SUCCESS)File(context.getExternalFilesDir(null),"pdf-comparison.png").outputStream().use {bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle();captured.countDown()},android.os.Handler(android.os.Looper.getMainLooper()))
            }
            assertTrue(captured.await(10,TimeUnit.SECONDS));assertEquals(android.view.PixelCopy.SUCCESS,captureResult)
            File(context.getExternalFilesDir(null),"pdf-comparison.json").writeText(evidence.toString())
            compose.onNodeWithText("结束对照").performClick()
            try {compose.waitUntil(15000){val remaining=views();remaining.size==1&&js(remaining[0],"!!document.querySelector('.pdf-page canvas')")=="true"&&position(remaining[0]).optInt("page",-1)==a.getInt("page")}}catch(e:Throwable){File(context.getExternalFilesDir(null),"pdf-close-debug.txt").writeText("PDF_CLOSE_STATE error=${model!!.state.value.error} anchor=${model!!.state.value.anchor} expected=$a");for(v in views())File(context.getExternalFilesDir(null),"pdf-close-debug.txt").appendText("\nPDF_CLOSE_DOM "+js(v,"JSON.stringify({body:document.body.innerText,status:document.querySelector('#status').textContent,pages:document.querySelectorAll('.pdf-page').length,canvases:document.querySelectorAll('.pdf-page canvas').length})"));throw e}
        }finally {shell("wm size ${Regex("Override size: (\\S+)").find(oldSize)?.groupValues?.get(1)?:"reset"} -d $display");shell("wm density ${Regex("Override density: (\\S+)").find(oldDensity)?.groupValues?.get(1)?:"reset"} -d $display");scenario.close();for(book in books)runCatching {repo.remove("books",repo.get("books",book.id))};repo.close();files.forEach {it.delete()}}
    }
}
