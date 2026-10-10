package org.shufang.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@SuppressLint("SetJavaScriptEnabled")
class DocumentWebView(context: Context, private val scope: CoroutineScope, private val events: (JSONObject) -> Unit) : WebView(context) {
    private val bridgeHandler=android.os.Handler(android.os.Looper.getMainLooper())
    private var released=false
    private val files = ConcurrentHashMap<String, Pair<File, String>>()
    private var parsedFile: File? = null
    private var parsedBytes = 0L
    private var generatedFile:File?=null
    private var generatedBytes=0L
    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        .addPathHandler("/resource/", WebViewAssetLoader.PathHandler { path ->
            files[path]?.let { (file, mime) -> WebResourceResponse(mime, null, file.inputStream()) }
                ?: WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), "".byteInputStream())
        }).build()
    init {
        settings.javaScriptEnabled = true
        // Reading typography already applies the system scale. WebView zoom
        // also scales canvas glyphs, corrupting PDF positions and OCR images.
        settings.textZoom = 100
        settings.setSupportZoom(true)
        settings.builtInZoomControls=true
        settings.displayZoomControls=false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.domStorageEnabled = false
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        fun dispatchMessage(text:String,reply:(String)->Unit) {
            scope.launch {
                val data = runCatching { JSONObject(text) }.getOrNull() ?: return@launch
                val answer = JSONObject().put("requestId", data.optLong("requestId"))
                try {
                    when (data.optString("type")) {
                        "fileBegin" -> withContext(Dispatchers.IO){generatedFile?.delete();generatedFile=File(context.cacheDir,"generated-${UUID.randomUUID()}.bin").apply {writeBytes(byteArrayOf())};generatedBytes=0L}
                        "fileChunk" -> withContext(Dispatchers.IO){val text=data.getString("base64");require(text.length<=90_000);val bytes=android.util.Base64.decode(text,android.util.Base64.NO_WRAP);generatedBytes+=bytes.size;require(generatedBytes<=256L*1024*1024);(generatedFile?:error("文件任务不存在")).appendBytes(bytes)}
                        "fileEnd" -> {val file=generatedFile?:error("文件任务不存在");data.put("path",file.path);generatedFile=null;events(data)}
                        "parsedBegin" -> withContext(Dispatchers.IO) {
                            parsedFile?.delete(); parsedFile = File(context.cacheDir, "parsed-${UUID.randomUUID()}.json").apply { writeText("") }; parsedBytes = 0
                        }
                        "parsedChunk" -> withContext(Dispatchers.IO) {
                            val text = data.getString("text"); require(text.length <= 65536)
                            val bytes = text.toByteArray(Charsets.UTF_8); parsedBytes += bytes.size
                            require(parsedBytes <= 256L * 1024 * 1024) { "解析正文过大" }
                            (parsedFile ?: error("解析任务不存在")).appendBytes(bytes)
                        }
                        "parsedEnd" -> { data.put("parsedPath", parsedFile?.absolutePath ?: error("解析任务不存在")); events(data) }
                        else -> events(data)
                    }
                    answer.put("value", true)
                } catch (error: Exception) { answer.put("error", error.message); events(JSONObject().put("type", "failure").put("error", error.message)) }
                // A caller may provide a scope with a dispatcher other than Main.
                // Both Android bridge implementations require replies on the WebView looper.
                bridgeHandler.post {if(!released)reply(answer.toString())}
            }
        }
        if(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(this,"ShufangBridge",setOf("https://appassets.androidplatform.net")) {_,message,source,mainFrame,reply->
                if(mainFrame&&source.toString()=="https://appassets.androidplatform.net")dispatchMessage(message.data?:"{}",reply::postMessage)
            }
        }else {
            // API 26's bundled WebView predates WebMessageListener. The fallback
            // exposes only the same bounded reader event protocol, never native commands.
            addJavascriptInterface(object {
                @android.webkit.JavascriptInterface fun postMessage(text:String) {
                    if(text.length>100_000)return
                    bridgeHandler.post {if(!released&&url=="https://appassets.androidplatform.net/assets/reader/index.html")dispatchMessage(text){answer->if(!released)evaluateJavascript("window.ShufangBridge.onmessage({data:"+JSONObject.quote(answer)+"})",null)}}
                }
            },"ShufangLegacyBridge")
        }
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.url.host != "appassets.androidplatform.net") return WebResourceResponse("text/plain", "utf-8", "".byteInputStream())
                return loader.shouldInterceptRequest(request.url)?:WebResourceResponse("text/plain","utf-8",404,"Not found",emptyMap(),"".byteInputStream())
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == "appassets.androidplatform.net") return request.isForMainFrame && request.url.path != "/assets/reader/index.html"
                if (request.url.scheme in listOf("https", "http")) context.startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }
        loadUrl("https://appassets.androidplatform.net/assets/reader/index.html")
    }
    fun resource(file: File, mime: String = "application/octet-stream"): String {
        val allowed = listOf(context.filesDir.canonicalFile, context.cacheDir.canonicalFile)
        require(allowed.any { file.canonicalPath.startsWith(it.path + File.separator) })
        val id = UUID.randomUUID().toString(); files[id] = file to mime
        return "https://appassets.androidplatform.net/resource/$id"
    }
    fun javascript(method: String, vararg args: Any?) {
        require(method in listOf("importFile", "showBook", "setType", "showTranslation", "turnPage", "searchPdf", "ocrPage", "exportPdf", "pdfPage", "pdfPosition", "pdfLayout", "pdfRegion", "pdfThumbnails"))
        val encoded = args.joinToString(",") { when (it) { null -> "null"; is String -> JSONObject.quote(it); else -> it.toString() } }
        val script="(()=>{try {Promise.resolve(window.shufang.$method($encoded)).catch(error=>ShufangBridge.postMessage(JSON.stringify({type:'failure',error:String(error)})))}catch(error){ShufangBridge.postMessage(JSON.stringify({type:'failure',error:String(error)}))}})()"
        if(android.os.Looper.myLooper()==android.os.Looper.getMainLooper())evaluateJavascript(script,null)
        else post {evaluateJavascript(script,null)}
    }
    override fun destroy() { released=true;generatedFile?.delete();parsedFile?.delete(); files.clear(); stopLoading(); super.destroy() }
}
