package org.shufang.android

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

data class SaveConflict(val repositoryKey:String,val kind:String,val id:String,val current:Record,val draft:JSONObject,val patch:JSONObject,val draftPath:String)
data class LibraryState(
    val conflictDrafts:List<String> = emptyList(),
    val saveConflict:SaveConflict?=null,
    val studyRestorePreview:JSONObject?=null,
    val downloadBookId:String?=null,
    val localAiStatus:String="",val aiSource:String="",val routes:AccountRouteGroup?=null,val routeMeasurements:List<RouteMeasurement> = emptyList(),val ocrText:String?=null,val ocrPage:Int=0,val inkMode:Boolean=false, val ready: Boolean = false, val busy: String = "", val error: String = "", val message: String = "",
    val records: Map<String, List<Record>> = emptyMap(), val view: String = "books", val query: String = "",
    val book: Record? = null, val chapterId: String = "", val anchor: JSONObject? = null,
    val selection: JSONObject? = null, val selectionSegments: JSONArray? = null,
    val importFile: File? = null, val importName: String = "", val importMode: String = "reflow",
    val remote: RemoteClient? = null, val mergeCounts: Map<String, Int>? = null,
    val aiResult: String = "", val aiTask: String = "chat", val aiConfig: JSONObject = JSONObject(),
    val reviewStudySet:String?=null,val review: List<Record> = emptyList(), val remoteStatus: JSONObject? = null,
    val searchResults: List<JSONObject> = emptyList(), val searchTotal: Int = 0,
    val associationSource: JSONObject? = null,
    val autoSync: Boolean = true, val aiModels:List<String> = emptyList(),
    val aiMessages:JSONArray=JSONArray(),val aiLanguage:String="中文",
    val serverStartup:JSONObject?=null,val serverCodex:JSONObject?=null,
    val canRecoverMerge:Boolean=false,
    val syncInfo:JSONObject?=null,
    val searchNext:Int?=null,val searchTruncated:Boolean=false,val studySetId:String?=null,
    val metadataCandidates:List<JSONObject> = emptyList(),
    val searchToken:Int=0,val searchComplete:Boolean=false,val searchWarnings:List<String> = emptyList(),
    val aiMindTarget:Record?=null,
    val importSaving:Boolean=false,
    val aiQuestion:String="",
)

class LibraryViewModel(application: Application) : AndroidViewModel(application) {
    companion object { val kinds = listOf("folders", "books", "reviews", "notes", "highlights", "translations", "mindMaps", "studySets", "associations", "preferences") }
    private val mutable = MutableStateFlow(LibraryState())
    val state = mutable.asStateFlow()
    var repository = CoreRepository(application); private set
    private var conflictCallback:((Record)->Unit)?=null
    private suspend fun showSaveConflict(repo:CoreRepository,kind:String,id:String,prior:Record?,patch:JSONObject,onSaved:((Record)->Unit)?=null) {
        require(repo===repository){"请回到发生冲突的书库处理草稿"}
        val current=repo.get(kind,id);val draft=JSONObject((prior?:current).value.toString());for(key in patch.keys())draft.put(key,patch.get(key))
        val file=File(repo.root,"conflict-draft-${UUID.randomUUID()}.json");withContext(Dispatchers.IO){file.writeText(JSONObject().put("kind",kind).put("id",id).put("draft",draft).put("patch",patch).toString())}
        conflictCallback=onSaved;mutable.update {it.copy(saveConflict=SaveConflict(repo.key,kind,id,current,draft,JSONObject(patch.toString()),file.path),error="")}
    }
    fun dismissSaveConflict(){mutable.update {it.copy(saveConflict=null)};conflictCallback=null}
    fun resumeConflictDraft(path:String)=perform("读取保留的草稿") {
        val repo=repository;val file=File(path).canonicalFile
        require(file.parentFile==repo.root.canonicalFile&&file.name.matches(Regex("conflict-draft-[0-9a-f-]+\\.json"))&&file.length()<=16L*1024*1024){"草稿路径无效"}
        val data=withContext(Dispatchers.IO){JSONObject(file.readText())}
        val kind=data.getString("kind");require(kind in kinds)
        val id=data.getString("id");val current=repo.get(kind,id)
        conflictCallback=null
        mutable.update {it.copy(saveConflict=SaveConflict(repo.key,kind,id,current,data.getJSONObject("draft"),data.getJSONObject("patch"),file.path))}
    }
    fun resolveSaveConflict(choice:String)=perform("处理保存冲突") {
        val conflict=mutable.value.saveConflict?:return@perform;require(repository.key==conflict.repositoryKey){"书库已切换，草稿保留"}
        val current=repository.get(conflict.kind,conflict.id)
        if(current.revision!=conflict.current.revision){mutable.update {it.copy(saveConflict=conflict.copy(current=current))};error("资料再次发生变化，请查看更新后的版本")}
        val result=when(choice){"remote"->current;"local"->repository.save(conflict.kind,current,conflict.patch);"copy"->{require(conflict.kind in listOf("notes","highlights","translations","mindMaps","studySets"));val copy=JSONObject(conflict.draft.toString());for(key in listOf("id","createdAt","updatedAt"))copy.remove(key);repository.save(conflict.kind,null,copy)};else->error("未知选择")}
        if(choice!="remote")File(conflict.draftPath).delete()
        mutable.update {it.copy(saveConflict=null,message=if(choice=="remote")"保留当前版本；草稿可在设置中重新打开"else "冲突选择已保存")};reload();if(choice!="remote"){conflictCallback?.invoke(result);scheduleSync()};conflictCallback=null
    }
    private fun studyScope()=JSONObject().put("origin",mutable.value.routes?.anchor?:mutable.value.remote?.origin?:"offline").put("userID",mutable.value.remote?.account?:"local")
    fun exportStudy(uri:Uri,setId:String?)=perform("导出学习资料") {
        val repo=repository;val file=File(repo.root,"study-export-${UUID.randomUUID()}.zip")
        try {val args=studyScope().put("path",file.path);setId?.let {args.put("studySetId",it)}
            repo.command("exportStudyBackup",args)
            withContext(Dispatchers.IO){getApplication<Application>().contentResolver.openOutputStream(uri,"wt")?.use {out->file.inputStream().use {it.copyTo(out)}}?:error("无法写入备份文件")}
            mutable.update {it.copy(message="学习资料已导出")}
        }finally {file.delete()}
    }
    fun previewStudy(uri:Uri,policy:String)=perform("校验学习备份") {
        val repo=repository;val archive=File(repo.root,"study-import-${UUID.randomUUID()}.zip")
        try {
            withContext(Dispatchers.IO){getApplication<Application>().contentResolver.openInputStream(uri)?.use {input->archive.outputStream().use {out->val buffer=ByteArray(65536);var total=0L;while(true){ensureActive();val n=input.read(buffer);if(n<0)break;total+=n;require(total<=512L*1024*1024){"学习包超过 512 MiB"};out.write(buffer,0,n)}}}?:error("无法读取备份文件")}
            val preview=repo.command("previewStudyRestore",studyScope().put("path",archive.path).put("policy",policy))
            mutable.value.studyRestorePreview?.let {repo.command("cancelStudyRestore",it)}
            mutable.update {it.copy(studyRestorePreview=preview)}
        }finally {archive.delete()}
    }
    fun cancelStudyRestore()=perform("取消恢复") {mutable.value.studyRestorePreview?.let {repository.command("cancelStudyRestore",it)};mutable.update {it.copy(studyRestorePreview=null)}}
    fun commitStudyRestore()=perform("备份并恢复学习资料") {
        val preview=mutable.value.studyRestorePreview?:error("请先预览备份")
        val result=repository.command("commitStudyRestore",preview)
        mutable.update {it.copy(studyRestorePreview=null,message="恢复完成；原书库备份：${result.optString("safetyBackup")}")};reload();scheduleSync()
    }
    private var pendingRepository: CoreRepository? = null
    private var previousConnection:RemoteClient? = null
    private val vault = SecretVault(application)
    private val localAi=LocalAi(application)
    private val preferences = application.getSharedPreferences("android-ui", 0)
    private var readingSession = UUID.randomUUID().toString()
    private var readingPosition = ReadingPosition("",0.0)
    private var foreground = true
    private var readingBeat: Job? = null
    private var readingClock: ForegroundReadingClock? = null
    private var readingFlush: Job? = null
    private var syncJob: Job? = null
    private var aiJob: Job? = null
    private var importJob: Job? = null
    private var activeNativeJob: String? = null
    private var searchGeneration=0
    private var searchArguments=JSONObject()
    private var routeProbe:Job?=null
    private val connectivity=getApplication<Application>().getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
    private val networkCallback=object:android.net.ConnectivityManager.NetworkCallback(){
        override fun onAvailable(network:android.net.Network){viewModelScope.launch {runCatching {refreshRoutes()}}}
        override fun onLost(network:android.net.Network){viewModelScope.launch {runCatching {refreshRoutes()}}}
    }
    private val routeGate=kotlinx.coroutines.sync.Mutex()
    private fun persistRoutes(group:AccountRouteGroup){if(!preferences.contains("connection-before-v2")){preferences.edit().putString("connection-before-v2",JSONObject().put("origin",preferences.getString("origin",null)).put("account",preferences.getString("account",null)).put("workspace",preferences.getString("workspace",null)).put("rootKey",preferences.getString("rootKey",null)).toString()).commit()};check(preferences.edit().putString("accountRoutesV2:${repository.key}",group.json().toString()).commit());mutable.update {it.copy(routes=group)}}
    fun addAccountRoute(address:String,username:String,password:String)=perform("验证新的连接地址") {
        val current=mutable.value.remote?:error("请先登录账号");require(current.mode=="account"){"账号多地址不使用节点令牌"}
        val initial=RemoteClient(vault,RemoteAddress.normalize(address),username);val login=initial.login(username,password)
        val candidate=initial.renamed(login.optJSONObject("user")?.optString("id")?.takeIf {it.isNotBlank()}?:username)
        val cap=candidate.request("/api/v2/capabilities");val old=mutable.value.routes?:AccountRouteGroup(current.origin,current.account,repository.workspaceId,listOf(current.origin),null)
        if(!old.accepts(candidate.account,cap.getString("workspaceId"))){candidate.logout();error("该地址的账户或同步工作区不一致，未加入自动选路")}
        val addresses=(old.addresses+candidate.origin).distinct();require(addresses.size<=8){"最多配置八个地址"};persistRoutes(old.copy(addresses=addresses));refreshRoutes()
    }
    fun chooseRoute(address:String?)=perform("选择连接地址") {val old=mutable.value.routes?:error("尚无多地址配置");require(address==null||address in old.addresses);persistRoutes(old.copy(manual=address));refreshRoutes()}
    fun removeRoute(address:String)=perform("移除连接地址") {val old=mutable.value.routes?:return@perform;require(address!=old.anchor&&address!=mutable.value.remote?.origin){"先切换到其他地址；存储锚点需保留"};persistRoutes(old.copy(addresses=old.addresses-address,manual=old.manual?.takeIf {it!=address}));RemoteClient(vault,address,old.userID).logout()}
    suspend fun refreshRoutes() {
        if(!foreground||!routeGate.tryLock())return
        try {val group=mutable.value.routes?:return;val repo=repository
            val results=coroutineScope {group.addresses.map {address->async {try {val client=RemoteClient(vault,address,group.userID);val session=client.request("/api/auth/session");val user=session.optJSONObject("user")?.optString("id")?:error("服务器未返回账号身份");val start=System.nanoTime();val cap=client.request("/api/v2/capabilities");require(group.accepts(user,cap.getString("workspaceId"))){"账号或工作区不一致"};RouteMeasurement(address,(System.nanoTime()-start)/1_000_000.0)}catch(error:Exception){if(error is CancellationException)throw error;RouteMeasurement(address,null,error.message)}}}.awaitAll()}
            if(repository!==repo||mutable.value.routes!=group)return
            mutable.update {it.copy(routeMeasurements=results)}
            val chosen=RouteSelection.best(results,mutable.value.remote?.origin,group.manual)
            if(chosen==null){mutable.update {it.copy(message="连接地址暂不可用，离线修改已保留")};return}
            if(syncJob?.isActive==true||(mutable.value.busy.isNotEmpty()&&mutable.value.busy !in listOf("选择连接地址","验证新的连接地址")))return
            if(chosen!=mutable.value.remote?.origin){val client=RemoteClient(vault,chosen,group.userID);mutable.update {it.copy(remote=client,message="已切换到 $chosen")};persistConnection(client,group.workspaceID)}
        }finally {routeGate.unlock()}
    }
    private val inkGate=kotlinx.coroutines.sync.Mutex()
    private val inkVersions=mutableMapOf<String,Record?>()
    suspend fun loadInk(repo:CoreRepository,bookId:String,page:Int):PortableInk? {
        val id=inkIdentity(bookId,page);val record=repo.list("notes").find {it.id==id}?.let {repo.get("notes",id)}
        inkVersions[repo.key+":"+id]=record
        val reference=record?.value?.optJSONObject("pdfPortableInk")
        if(reference==null){require(record?.value?.has("pdfDrawing")!=true){"此页包含 iOS 历史手写，请先在新版 iOS 转换；原附件已保留"};return null}
        val file=repo.command("attachmentResource",JSONObject().put("reference",reference)).getString("path")
        return withContext(Dispatchers.IO){val source=File(file);require(source.length()<=32L*1024*1024){"手写附件过大"};PortableInk.decode(JSONObject(source.readText()))}
    }
    suspend fun loadInkPreview(repo:CoreRepository,bookId:String,page:Int):android.graphics.Bitmap? {
        val record=inkVersions[repo.key+":"+inkIdentity(bookId,page)]?:return null
        val reference=record.value.optJSONObject("pdfPreview")?:return null
        val resource=repo.command("attachmentResource",JSONObject().put("reference",reference))
        return withContext(Dispatchers.IO){val path=resource.getString("path");val options=android.graphics.BitmapFactory.Options().apply {inJustDecodeBounds=true};android.graphics.BitmapFactory.decodeFile(path,options);require(options.outWidth in 1..8192&&options.outHeight in 1..8192){"手写预览尺寸无效"};options.inJustDecodeBounds=false;options.inSampleSize=maxOf(1,maxOf(options.outWidth,options.outHeight)/1600);android.graphics.BitmapFactory.decodeFile(path,options)}
    }
    fun saveInk(repo:CoreRepository,bookId:String,page:Int,value:PortableInk)=viewModelScope.launch {
        inkGate.lock()
        val file=File(repo.root,"ink-draft-${UUID.randomUUID()}.json")
        try {
            withContext(Dispatchers.IO){file.writeText(value.json().toString())}
            val reference=repo.command("putAttachment",JSONObject().put("path",file.path).put("name","drawing.ink.json").put("type","application/vnd.shufang.ink+json"))
            val id=inkIdentity(bookId,page);val prior=inkVersions[repo.key+":"+id]
            val patch=JSONObject().put("title","第 $page 页手写").put("content","").put("bookId",bookId).put("pdfPage",page).put("pdfPortableInk",reference)
            val preview=InkPreview.write(repo.root,value)
            try {patch.put("pdfPreview",repo.command("putAttachment",JSONObject().put("path",preview.path).put("name","drawing.png").put("type","image/png")))}finally {preview.delete()}
            val saved=try {if(prior==null){Record.from(repo.command("save",JSONObject().put("kind","notes").put("id",id).put("expected",0).put("patch",patch)))}else repo.save("notes",prior,patch)}catch(e:IllegalStateException){if(e.message=="revision_conflict"){showSaveConflict(repo,"notes",id,prior,patch){if(it.id==id)inkVersions[repo.key+":"+id]=it else inkVersions.remove(repo.key+":"+id)};return@launch};throw e}
            inkVersions[repo.key+":"+id]=saved;file.delete();if(repository===repo)scheduleSync()
        }catch(error:Exception){mutable.update {it.copy(error="手写尚未保存：${error.message}；草稿已保留")}}
        finally {inkGate.unlock()}
    }
    private fun inkIdentity(bookId:String,page:Int)="pdfink."+java.security.MessageDigest.getInstance("SHA-256").digest(bookId.toByteArray()).joinToString(""){"%02x".format(it)}+".$page"
    init { perform("打开本地书库") {
        val origin=preferences.getString("origin",null);val account=preferences.getString("account",null);val workspace=preferences.getString("workspace",null)
        if(origin!=null&&account!=null&&workspace!=null) {
            val remote=RemoteClient(vault,origin,account,preferences.getString("authMode","account")?:"account");repository=CoreRepository(getApplication(),preferences.getString("rootKey","remote-${remote.identity}")?:"remote-${remote.identity}")
            repository.open(workspace);mutable.update {it.copy(remote=remote)}
        } else repository.open()
        preferences.getString("accountRoutesV2:${repository.key}",null)?.let {value->val group=AccountRouteGroup.decode(JSONObject(value));require(group.userID==mutable.value.remote?.account&&group.workspaceID==repository.workspaceId);mutable.update {it.copy(routes=group)}}
        connectivity.registerDefaultNetworkCallback(networkCallback)
        routeProbe=viewModelScope.launch {while(isActive){delay(45_000);runCatching {refreshRoutes()}}}
        reload();mutable.update {it.copy(localAiStatus=localAi.status(),inkMode=preferences.getBoolean("inkMode",false),ready=true,autoSync=preferences.getBoolean("autoSync",true),canRecoverMerge=preferences.contains("mergeRecovery"))};registerPeriodicSync()
        val route=preferences.getString("route:${repository.key}","books")?:"books"
        val lastBook=preferences.getString("lastBook:${repository.key}",null)
        if(route=="reader" && lastBook!=null && mutable.value.records["books"].orEmpty().any {it.id==lastBook})openBook(lastBook).join()
        else if(route in kinds+listOf("history","graph","search","settings","review","ai")){navigate(route);if(route=="review")loadReview()}
    } }
    fun perform(label: String, operation: suspend () -> Unit) = viewModelScope.launch {
        mutable.update { it.copy(busy=label,error="",message="") }
        try { operation() } catch (error: Exception) { if(error is CancellationException)throw error;mutable.update { it.copy(error=error.message ?: error.javaClass.simpleName) } }
        finally { mutable.update { it.copy(busy="") } }
    }
    suspend fun reload() {
        val data=kinds.associateWith {repository.list(it)}
        val config=repository.command("aiConfig")
        val active=mutable.value.book?.id
        val full=active?.takeIf {id->data["books"].orEmpty().any {it.id==id}}?.let {repository.get("books",it)}
        val drafts=withContext(Dispatchers.IO){repository.root.listFiles().orEmpty().filter {it.isFile&&it.name.matches(Regex("conflict-draft-[0-9a-f-]+\\.json"))}.sortedByDescending {it.lastModified()}.map {it.path}}
        mutable.update {it.copy(conflictDrafts=drafts,records=data,aiConfig=config,book=full,view=if(active!=null&&full==null&&it.view=="reader")"books"else it.view)}
    }
    fun navigate(view: String) { val flush=if(view!="reader")stopReading()else null;preferences.edit().putString("route:${repository.key}",view).apply();mutable.update {it.copy(view=view)};if(view=="history")viewModelScope.launch {flush?.join();reload()} }
    fun foreground(value:Boolean) {creditReading(value);foreground=value;if(value)viewModelScope.launch {runCatching {refreshRoutes()}};if(!value&&readingBeat!=null)viewModelScope.launch {runCatching {checkpoint(readingPosition.chapter,readingPosition.ratio)}}}
    private fun creditReading(active:Boolean=foreground) {readingClock?.let {readingPosition.tick(it.elapsed(active),true)}}
    fun inkMode(enabled:Boolean){preferences.edit().putBoolean("inkMode",enabled).apply();mutable.update {it.copy(inkMode=enabled)}}
    fun dismissOcr(){mutable.update {it.copy(ocrText=null)}}
    fun saveOcr(text:String)=perform("保存校正文字") {val current=mutable.value;val book=current.book?:error("请先打开 PDF");require(text.isNotBlank());val anchor=JSONObject().put("bookId",book.id).put("chapterId","").put("chapterTitle","第 ${current.ocrPage} 页").put("text",text).put("name","OCR 校正").put("pdfAnchor",JSONObject().put("page",current.ocrPage).put("rects",JSONArray().put(JSONObject().put("x",0).put("y",0).put("width",1).put("height",1))));repository.save("highlights",null,anchor);reload();dismissOcr();scheduleSync()}
    fun query(value: String) { mutable.update {it.copy(query=value)} }
    fun search(query:String,kind:String="all",bookIds:List<String>?=null)=perform("搜索正文与笔记") {
        val args=JSONObject().put("query",query).put("kind",kind).put("limit",200)
        bookIds?.let {args.put("bookIds",JSONArray(it))}
        val generation=++searchGeneration;searchArguments=args
        mutable.update {it.copy(searchToken=generation,searchComplete=false,searchWarnings=emptyList())}
        val result=repository.command("searchPage",args);val items=result.getJSONArray("items")
        if(generation==searchGeneration)mutable.update {it.copy(searchResults=(0 until items.length()).map {i->items.getJSONObject(i)},searchTotal=result.getInt("total"),searchNext=if(result.isNull("nextOffset"))null else result.getInt("nextOffset"),searchTruncated=result.optBoolean("truncated"),searchComplete=true)}
    }
    fun pdfSearchEvent(event:JSONObject) {
        if(event.optInt("generation")!=mutable.value.searchToken)return
        val book=mutable.value.records["books"].orEmpty().find {it.id==event.optString("bookId")}?:return
        when(event.optString("type")) {
            "pdfSearchHit"->{val page=event.getInt("page");require(page>0)
                val anchor=JSONObject().put("bookId",book.id).put("chapterId","").put("chapterTitle","第 $page 页").put("pdfAnchor",JSONObject().put("page",page).put("rects",JSONArray()))
                val hit=JSONObject().put("kind","books").put("record",JSONObject().put("revision",book.revision).put("value",book.value)).put("anchor",anchor).put("preview",event.optString("text"))
                mutable.update {it.copy(searchResults=if(it.searchResults.size<500)it.searchResults+hit else it.searchResults,searchTotal=it.searchTotal+1,searchTruncated=it.searchTruncated||it.searchResults.size>=500)}
            }
            "pdfSearchEnd"->if(event.has("error")||event.optInt("emptyPages")>0||event.optBoolean("truncated"))mutable.update {it.copy(searchWarnings=it.searchWarnings+"《${book.text("title")}》：${if(event.has("error"))event.optString("error")else if(event.optBoolean("truncated"))"PDF 结果达到 500 项，请缩小范围"else "${event.optInt("emptyPages")} 页没有可搜索文字，未启用 OCR"}")}
        }
    }
    fun moreSearch()=perform("加载搜索结果") {
        val next=mutable.value.searchNext?:return@perform;val generation=searchGeneration
        val result=repository.command("searchPage",JSONObject(searchArguments.toString()).put("offset",next));val items=result.getJSONArray("items")
        if(generation==searchGeneration)mutable.update {it.copy(searchResults=(it.searchResults+(0 until items.length()).map {i->items.getJSONObject(i)}).take(500),searchNext=if(result.isNull("nextOffset"))null else result.getInt("nextOffset"),searchTruncated=it.searchTruncated||it.searchResults.size+items.length()>500)}
    }
    fun openStudySet(id:String){mutable.update {it.copy(studySetId=id,view="studySetDetail")}}
    fun clearError() {mutable.update {it.copy(error="",message="")} }
    fun preference(key:String,value:String)=perform("保存偏好") {
        val prior=mutable.value.records["preferences"]?.find {it.id==key}
        repository.command("save",JSONObject().put("kind","preferences").put("id",key).put("expected",prior?.revision?:0).put("patch",JSONObject().put("value",value)));reload();scheduleSync()
    }
    fun resetBookType()=perform("恢复通用排版") {
        val book=mutable.value.book?:error("请先打开书籍")
        repository.command("save",JSONObject().put("kind","books").put("id",book.id).put("expected",book.revision).put("patch",JSONObject()).put("unset",JSONArray().put("typeSettings")));reload();scheduleSync()
    }
    fun adjustFont(delta:Int)=perform("保存阅读字号") {
        val book=mutable.value.book?:error("请先打开书籍")
        val general=runCatching {JSONObject(mutable.value.records["preferences"].orEmpty().find {it.id=="shufang-type2"}?.text("value")?:"{}")}.getOrDefault(JSONObject())
        val settings=JSONObject((book.value.optJSONObject("typeSettings")?:general).toString()).put("fontSize",((book.value.optJSONObject("typeSettings")?:general).optInt("fontSize",19)+delta).coerceIn(12,36))
        repository.save("books",book,JSONObject().put("typeSettings",settings));reload();scheduleSync()
    }
    fun beginAssociation() {val selection=mutable.value.selection?:return;stopReading();mutable.update {it.copy(associationSource=JSONObject(selection.toString()),view="books",message="选择目标书籍，再选中要关联的文段")}}
    fun cancelAssociation(){mutable.update {it.copy(associationSource=null)}}
    fun finishAssociation(label:String,direction:String)=perform("保存文段关联") {
        val state=mutable.value;repository.save("associations",null,JSONObject().put("source",state.associationSource?:error("请先选择源文段")).put("target",state.selection?:error("请先选择目标文段")).put("label",label).put("direction",direction));reload();mutable.update {it.copy(associationSource=null,message="文段关联已保存")};scheduleSync()
    }
    fun citeSelection(note:Record)=perform("引用选文到笔记") {
        val values=mutable.value.selectionSegments?:JSONArray().put(mutable.value.selection?:error("请选择正文"))
        for(index in 0 until values.length()) {
            val patch=JSONObject(values.getJSONObject(index).toString()).apply {remove("kind");put("note","")}
            val prior=mutable.value.records["highlights"].orEmpty().find {it.id==patch.optString("id")}
            val quote=prior?:repository.save("highlights",null,patch);val fresh=repository.get("notes",note.id)
            repository.command("cite",JSONObject().put("highlight",quote.id).put("note",note.id).put("highlightRevision",quote.revision).put("noteRevision",fresh.revision))
        };reload();scheduleSync()
    }
    fun openComparedSelection(id:String,event:JSONObject)=viewModelScope.launch {
        val anchor=event.getJSONObject("anchor")
        require(anchor.optString("bookId")==id){"选区来源不一致"}
        openBook(id,anchor).join()
        if(mutable.value.book?.id==id)documentEvent(event)
    }
    fun resumeComparedBook(id:String):Job {
        val text=getApplication<Application>().getSharedPreferences("pdf-comparison",0).getString("${repository.key}:$id",null)
        return openBook(id,text?.let {JSONObject().put("pdfAnchor",JSONObject(it))})
    }
    fun openBook(id:String, anchor:JSONObject?=null) = perform("打开书籍") {
        if(!repository.command("downloadState",JSONObject().put("id",id)).getBoolean("enabled")){mutable.update {it.copy(downloadBookId=id)};return@perform}
        stopReading()?.join();var book=repository.get("books",id);readingSession=UUID.randomUUID().toString()
        if(anchor?.has("pdfAnchor")==true && book.text("readerMode")!="original")book=repository.save("books",book,JSONObject().put("readerMode","original"))
        if(anchor?.optString("readerMode")=="reflow" && book.text("readerMode")=="original" && book.value.optJSONArray("chapters")?.length()!=0)book=repository.save("books",book,JSONObject().put("readerMode","reflow"))
        val chapters=book.value.optJSONArray("chapters")?:JSONArray()
        val chapter=anchor?.optString("chapterId")?.takeIf {it.isNotEmpty()} ?: book.value.optJSONObject("progress")?.optString("chapterId")?.takeIf {it.isNotEmpty()} ?: chapters.optJSONObject(0)?.optString("id").orEmpty()
        mutable.update {it.copy(view="reader",book=book,chapterId=chapter,anchor=anchor,selection=null,aiMindTarget=null,aiResult=if(it.book?.id==id)it.aiResult else "",aiMessages=if(it.book?.id==id)it.aiMessages else JSONArray())}
        preferences.edit().putString("route:${repository.key}","reader").putString("lastBook:${repository.key}",id).apply()
        readingPosition=ReadingPosition(chapter,book.value.optJSONObject("progress")?.optDouble("ratio")?:0.0)
        readingClock=ForegroundReadingClock(foreground,android.os.SystemClock::elapsedRealtime)
        readingBeat=viewModelScope.launch {var ticks=0;while(isActive) {delay(1000);creditReading();if(++ticks%15==0&&foreground)runCatching { checkpoint(readingPosition.chapter,readingPosition.ratio) }}}
    }
    fun dismissDownload(){mutable.update {it.copy(downloadBookId=null)}}
    fun removeDownload(book:Record)=perform("移除本机下载") {
        val result=repository.command("removeDownload",JSONObject().put("id",book.id))
        if(mutable.value.book?.id==book.id){stopReading()?.join();mutable.update {it.copy(view="books",book=null,selection=null)}}
        mutable.update {it.copy(message="已移除本机下载，书籍和学习记录保留。释放 ${result.optLong("releasedBytes")/1024} KiB；共享对象仍保留。")};reload()
    }
    fun redownload()=perform("重新下载原文件") {
        val id=mutable.value.downloadBookId?:return@perform;val repo=repository;val remote=mutable.value.remote?:error("请先连接服务器；书籍和学习记录仍在本机")
        val cap=remote.request("/api/v2/capabilities");repo.command("enableDownload",JSONObject().put("id",id))
        try {awaitJob(repo,repo.command("syncOnce",remote.syncArguments(cap.getString("nodeId"))));repo.command("bookResource",JSONObject().put("id",id));mutable.update {it.copy(downloadBookId=null)};openBook(id)}
        catch(e:Exception){repo.command("removeDownload",JSONObject().put("id",id));throw e}
    }
    private fun stopReading():Job? {
        if(readingBeat==null)return readingFlush
        creditReading(false);readingClock=null;readingBeat?.cancel();readingBeat=null
        val book=mutable.value.book?:return readingFlush
        val repo=repository;val session=readingSession
        val args=JSONObject().put("id",book.id).put("session",session).put("progress",JSONObject().put("chapterId",readingPosition.chapter).put("ratio",readingPosition.ratio)).put("activeSeconds",readingPosition.activeSeconds).put("summary",true)
        readingFlush=viewModelScope.launch {runCatching {repo.command("checkpoint",args)}}
        return readingFlush
    }
    fun chapter(id:String) {readingPosition.move(id,0.0);mutable.update {it.copy(chapterId=id,anchor=null,selection=null)} }
    suspend fun checkpoint(chapter:String,ratio:Double) {
        val book=mutable.value.book?:return
        creditReading()
        readingPosition.move(chapter,ratio)
        val saved=Record.from(repository.command("checkpoint",JSONObject().put("id",book.id).put("session",readingSession)
            .put("progress",JSONObject().put("chapterId",readingPosition.chapter).put("ratio",readingPosition.ratio)).put("activeSeconds",readingPosition.activeSeconds).put("summary",true)))
        mutable.update {current->if(current.book?.id==saved.id){val value=JSONObject();current.book.value.keys().forEach {key->value.put(key,current.book.value.get(key))};saved.value.keys().forEach {key->value.put(key,saved.value.get(key))};current.copy(book=Record(saved.revision,value))}else current}
    }
    fun documentEvent(event:JSONObject) {
        when(event.optString("type")) {
            "fileEnd" -> perform("处理文档输出") {val file=File(event.getString("path"));try {when(event.optString("purpose")){"ocr"->{val text=PageOcr.recognize(file);mutable.update {it.copy(ocrText=text,ocrPage=event.getInt("page"))}};"annotatedPdf"->{Sharing.file(getApplication(),file,(mutable.value.book?.text("title")?:"阅读批注")+"-批注.pdf","application/pdf")}}}finally {file.delete()}}
            "progress" -> mutable.update {it.copy(busy=event.optString("stage"))}
            "failure" -> mutable.update {it.copy(error=event.optString("error"),busy="")}
            "chapterTurn" -> {val book=mutable.value.book?:return;val chapters=book.value.optJSONArray("chapters")?:return;val index=(0 until chapters.length()).indexOfFirst {chapters.getJSONObject(it).optString("id")==mutable.value.chapterId};val delta=event.optInt("delta");val next=index+delta;if(delta in listOf(-1,1)&&next in 0 until chapters.length()){readingPosition.move(chapters.getJSONObject(next).getString("id"),if(delta<0)1.0 else 0.0);mutable.update {it.copy(chapterId=chapters.getJSONObject(next).getString("id"),anchor=JSONObject().put("ratio",if(delta<0)1 else 0),selection=null)}}}
            "selection" -> {
                val anchor=event.getJSONObject("anchor")
                if(mutable.value.records["highlights"].orEmpty().any {it.id==anchor.optString("id")})perform("读取书摘") {val full=repository.get("highlights",anchor.getString("id"));mutable.update {it.copy(selection=full.value,selectionSegments=null)}}
                else mutable.update {it.copy(selection=anchor,selectionSegments=event.optJSONArray("segments"))}
            }
            "progressPosition" -> {
                val navigationAnchor=mutable.value.anchor
                viewModelScope.launch {runCatching {checkpoint(event.optString("chapterId"),event.optDouble("ratio"))};mutable.update {
                    if(it.anchor===navigationAnchor&&!(it.book?.text("format")=="pdf"&&it.book.text("readerMode")=="original"))it.copy(anchor=null)else it
                }}
            }
            "parsedEnd" -> perform("保存书籍") {
                val source=mutable.value.importFile?:error("导入任务已失效")
                val parsed=File(event.getString("parsedPath"))
                mutable.update {it.copy(importSaving=true)}
                try {repository.command("importParsed",JSONObject().put("path",source.absolutePath).put("parsedPath",parsed.absolutePath).put("readerMode",mutable.value.importMode));reload()
                    mutable.update {it.copy(importFile=null,message="导入完成",view="books")};scheduleSync()
                } finally {parsed.delete();source.delete();mutable.update {it.copy(importFile=null,importSaving=false)}}
            }
        }
    }
    fun import(uri:Uri,mode:String):Job {
        if(!mutable.value.importSaving)cancelImport()
        val job=perform("读取导入文件") {
        require(!mutable.value.importSaving){"请等待当前书籍保存完成"}
        val resolver=getApplication<Application>().contentResolver
        val display=resolver.query(uri,arrayOf(android.provider.OpenableColumns.DISPLAY_NAME),null,null,null)?.use {if(it.moveToFirst())it.getString(0)else null}?:"book.txt"
        val extension=display.substringAfterLast('.').lowercase();require(extension in listOf("pdf","epub","mobi","azw","azw3","fb2","txt")) {"不支持的文件格式"}
        val directory=File(getApplication<Application>().cacheDir,"imports/${UUID.randomUUID()}").apply {mkdirs()}
        val source=File(directory,display.substringBeforeLast('.').replace(Regex("[\\\\/:*?\"<>|]"),"_").take(150)+".$extension")
        withContext(Dispatchers.IO) {
            try {resolver.openInputStream(uri)?.use {input->source.outputStream().use {output->val buffer=ByteArray(256*1024);var total=0L
                while(true){ensureActive();val read=input.read(buffer);if(read<0)break;total+=read;require(total<=(if(extension=="txt")64L else 128L)*1024*1024){"文件超过网页端格式上限"};output.write(buffer,0,read)}
            }}?:error("无法打开文件")}catch(error:Exception){source.delete();throw error}
        }
        mutable.update {it.copy(importFile=source,importName=display,importMode=mode)}
        };importJob=job;return job
    }
    fun cancelImport() {if(mutable.value.importSaving)return;importJob?.cancel();mutable.value.importFile?.delete();mutable.update {it.copy(importFile=null,busy="",message="已取消导入")} }
    fun shareOriginal(book:Record)=perform("准备原文件分享") {
        val source=File(repository.command("bookResource",JSONObject().put("id",book.id)).getString("path"))
        val mime=when(book.text("format")){"txt"->"text/plain";"pdf"->"application/pdf";"epub"->"application/epub+zip";"fb2"->"application/x-fictionbook+xml";"mobi","azw","azw3"->"application/x-mobipocket-ebook";else->"application/octet-stream"}
        Sharing.file(getApplication(),source,book.text("title")+"."+book.text("format"),mime)
    }
    fun save(kind:String,record:Record?,patch:JSONObject,onSaved:((Record)->Unit)?=null)=perform("保存") {
        var prior=record
        if(kind=="books"&&record!=null) {
            val current=repository.get("books",record.id)
            if(current.revision!=record.revision) {if(!canRebaseBookEdit(record,current,patch)){showSaveConflict(repository,kind,record.id,record,patch,onSaved);return@perform};prior=current}
        }
        val result=try {repository.save(kind,prior,patch)}catch(e:IllegalStateException){if(e.message=="revision_conflict"&&record!=null){showSaveConflict(repository,kind,record.id,record,patch,onSaved);return@perform};throw e};reload();onSaved?.invoke(result);scheduleSync()
    }
    fun moveBooks(records:List<Record>,folder:String?)=perform("移动书籍") {
        for(record in records) {
            repository.command("save",JSONObject().put("kind","books").put("id",record.id).put("expected",record.revision)
                .put("patch",if(folder==null)JSONObject()else JSONObject().put("folderId",folder))
                .put("unset",if(folder==null)JSONArray().put("folderId")else JSONArray()))
        };reload();scheduleSync()
    }
    fun setCover(book:Record,uri:Uri)=perform("更新封面") {
        val file=File(getApplication<Application>().cacheDir,"cover-${UUID.randomUUID()}")
        try {withContext(Dispatchers.IO){getApplication<Application>().contentResolver.openInputStream(uri)?.use {input->file.outputStream().use {output->val buffer=ByteArray(64*1024);var total=0L;while(true){val count=input.read(buffer);if(count<0)break;ensureActive();total+=count;require(total<=8*1024*1024){"封面不能超过 8 MiB"};output.write(buffer,0,count)}}}?:error("无法读取封面")}
            val current=repository.get("books",book.id)
            require(current.revision==book.revision||canRebaseBookEdit(book,current,JSONObject().put("customCover",true))){"封面已由其他操作修改，请重新选择"}
            repository.command("setCover",JSONObject().put("id",book.id).put("expected",current.revision).put("path",file.absolutePath));reload()
            if(mutable.value.book?.id==book.id) {val full=repository.get("books",book.id);mutable.update {it.copy(book=full)}}
            scheduleSync()
        }finally {file.delete()}
    }
    fun outline(action:String,entry:String="",title:String="",target:JSONObject?=null)=perform("编辑目录") {
        val book=mutable.value.book?:error("请先打开书籍")
        val args=JSONObject().put("id",book.id).put("expected",book.revision).put("action",action).put("entry",entry).put("title",title)
        target?.let {args.put("target",it)}
        val saved=Record.from(repository.command("editOutline",args));mutable.update {it.copy(book=saved)};reload();scheduleSync()
    }
    fun createCitation(level:String,note:Record)=perform("引用到笔记") {
        val state=mutable.value;val book=state.book?:error("请先打开书籍")
        val citation=JSONObject().put("level",level)
        val patch=JSONObject().put("bookId",book.id).put("citation",citation).put("chapterId","").put("chapterTitle","").put("text",book.text("title")).put("note","")
        if(level=="chapter") {val chapters=book.value.getJSONArray("chapters");val chapter=(0 until chapters.length()).map {chapters.getJSONObject(it)}.first {it.optString("id")==state.chapterId};patch.put("chapterId",state.chapterId).put("chapterTitle",chapter.optString("title")).put("text",chapter.optString("title"));citation.put("chapterId",state.chapterId)}
        val highlight=repository.save("highlights",null,patch)
        repository.command("cite",JSONObject().put("highlight",highlight.id).put("note",note.id).put("highlightRevision",highlight.revision).put("noteRevision",note.revision));reload();scheduleSync()
    }
    fun delete(kind:String,records:List<Record>)=perform("删除") {for(record in records)repository.remove(kind,record);reload();scheduleSync()}
    fun saveSelection(note:String="",style:String="background",color:String="yellow",onSaved:()->Unit={})=perform("保存书摘") {
        require(style in listOf("background","underline","color")&&color in listOf("orange","yellow","green","blue","purple"))
        val values=mutable.value.selectionSegments ?: JSONArray().put(mutable.value.selection?:error("请先选择正文"))
        require(values.length()>0)
        val patch=JSONObject(values.getJSONObject(0).toString()).apply {
            remove("kind");put("note",note);put("style",JSONObject().put("kind",style).put("color",color))
            if(values.length()>1){put("sourceRanges",values);put("text",(0 until values.length()).joinToString("\n"){values.getJSONObject(it).getString("text")})}
        }
        val prior=mutable.value.records["highlights"].orEmpty().find {it.id==patch.optString("id")}
        val full=prior?.let {repository.get("highlights",it.id)}
        val edit=full?.let {JSONObject(it.value.toString()).put("note",note).put("style",patch.getJSONObject("style"))}?:patch
        repository.save("highlights",full,edit)
        reload();mutable.update {it.copy(selection=null,message="书摘已保存")};onSaved();scheduleSync()
    }
    fun dismissSelection() {mutable.update {it.copy(selection=null)} }
    fun cite(highlight:Record,note:Record)=perform("引用到笔记") {
        repository.command("cite",JSONObject().put("highlight",highlight.id).put("note",note.id).put("highlightRevision",highlight.revision).put("noteRevision",note.revision));reload();scheduleSync()
    }
    fun uncite(highlight:Record,note:Record,onSaved:()->Unit={})=perform("取消引用") {
        require(highlight.text("noteId")==note.id){"引用所属笔记已改变，请重新打开"}
        repository.command("uncite",JSONObject().put("highlight",highlight.id).put("highlightRevision",highlight.revision).put("noteRevision",note.revision));reload();onSaved();scheduleSync()
    }
    fun enableReview(record:Record,enabled:Boolean)=perform("更新复习卡") {
        repository.command("setReview",JSONObject().put("id",record.id).put("enabled",enabled).put("expected",record.revision));reload();loadReview();scheduleSync()
    }
    suspend fun loadReview(studySet:String?=mutable.value.reviewStudySet) {
        val args=JSONObject();studySet?.let {args.put("studySet",it)}
        val items=repository.command("reviewQueue",args).getJSONArray("items")
        mutable.update {it.copy(review=(0 until items.length()).map {i->Record.from(items.getJSONObject(i))})}
    }
    fun reviewQueue(studySet:String?=null)=perform("读取复习队列") {mutable.update {it.copy(reviewStudySet=studySet)};loadReview(studySet);navigate("review")}
    fun rate(record:Record,rating:Int)=perform("保存复习结果") {
        repository.command("review",JSONObject().put("id",record.id).put("rating",rating).put("expected",record.revision));reload();loadReview();scheduleSync()
    }
    fun connect(origin:String,account:String,password:String)=perform("登录服务器") {
        val initial=RemoteClient(vault,RemoteAddress.normalize(origin),account)
        val login=initial.login(account,password)
        val client=initial.renamed(login.optJSONObject("user")?.optString("id")?.takeIf {it.isNotBlank()}?:account)
        val session=client.request("/api/auth/session")
        if(session.optBoolean("setupRequired")) {mutable.update {it.copy(remote=client,remoteStatus=session,view="settings")};return@perform}
        prepareConnection(client)
    }
    fun connectNode(origin:String,node:String,token:String)=perform("连接高级同步节点") {
        val client=RemoteClient(vault,RemoteAddress.normalize(origin),node,"node");client.token(token);prepareConnection(client)
    }
    private suspend fun prepareConnection(client:RemoteClient) {
        previousConnection=if(repository.key=="local")null else mutable.value.remote
        previousConnection?.takeIf {it.identity!=client.identity}?.let {old->val work=WorkManager.getInstance(getApplication());work.cancelUniqueWork("shufang-sync-${old.identity}");work.cancelUniqueWork("shufang-periodic-${old.identity}")}
        syncJob?.cancel();pendingRepository?.close()
        val cap=client.request("/api/v2/capabilities")
        if(client.mode=="node")require(cap.getString("nodeId")==client.account){"服务器节点身份与配置不一致"}
        val root=preferences.getString("workspaceRoot:${client.identity}","remote-${client.identity}")?:"remote-${client.identity}"
        if(repository.key==root){mutable.update {it.copy(remote=client,remoteStatus=cap)};persistConnection(client,cap.getString("workspaceId"));syncNow();return}
        val target=CoreRepository(getApplication(),root);target.open(cap.getString("workspaceId"))
        pendingRepository=target
        awaitJob(target,target.command("syncOnce",client.syncArguments(cap.getString("nodeId"))))
        mutable.update {it.copy(remote=client,remoteStatus=cap,mergeCounts=it.records.mapValues {(_,values)->values.size})}
    }
    private fun persistConnection(remote:RemoteClient,workspace:String,completedBatch:String?=null){preferences.edit().putString("origin",remote.origin).putString("account",remote.account).putString("authMode",remote.mode).putString("workspace",workspace).putString("rootKey",repository.key).putString("workspaceRoot:${remote.identity}",repository.key).apply {completedBatch?.let {remove(it)}}.commit();registerPeriodicSync()}
    fun confirmMerge()=perform("备份并合并本地书库") {
        stopReading()?.join()
        val target=pendingRepository?:error("连接任务不存在");val remote=mutable.value.remote?:error("尚未登录")
        val batchKey="mergeBatch:${repository.key}:${remote.identity}"
        if(repository.root.canonicalFile!=target.root.canonicalFile) {
            val recovery=JSONObject().put("root",repository.key).put("workspace",repository.workspaceId)
            previousConnection?.let {recovery.put("origin",it.origin).put("account",it.account).put("mode",it.mode)}
            preferences.edit().putString("mergeRecovery",recovery.toString()).commit()
            awaitJob(repository,repository.command("backup",JSONObject().put("path",File(repository.root,"before-android-merge-${UUID.randomUUID()}.zip").absolutePath)))
            val batch=preferences.getString(batchKey,null)?:UUID.randomUUID().toString().also {preferences.edit().putString(batchKey,it).commit()}
            repository.command("mergeInto",JSONObject().put("destination",target.root.absolutePath).put("workspace",mutable.value.remoteStatus!!.getString("workspaceId"))
                .put("replica",File(target.root,"replica-id").readText()).put("batch",batch))
            repository.close()
        }
        repository=target;pendingRepository=null
        persistConnection(remote,mutable.value.remoteStatus!!.getString("workspaceId"),batchKey)
        mutable.update {it.copy(mergeCounts=null,canRecoverMerge=true,message="本地书库已合并，正在上传")};reload();syncNow()
    }
    fun cancelMerge()=perform("返回原书库") {pendingRepository?.close();pendingRepository=null;mutable.update {it.copy(mergeCounts=null,remote=previousConnection,message="原书库已保留")};previousConnection=null}
    fun recoverOriginal()=perform("返回合并前的本地书库") {
        stopReading()?.join()
        val recovery=JSONObject(preferences.getString("mergeRecovery",null)?:error("没有待恢复的原书库"))
        syncJob?.cancel();mutable.value.remote?.let {remote->val work=WorkManager.getInstance(getApplication());work.cancelUniqueWork("shufang-sync-${remote.identity}");work.cancelUniqueWork("shufang-periodic-${remote.identity}")}
        pendingRepository?.close();pendingRepository=null;repository.close()
        repository=CoreRepository(getApplication(),recovery.getString("root"));repository.open(recovery.getString("workspace"))
        val remote=if(recovery.has("origin"))RemoteClient(vault,recovery.getString("origin"),recovery.getString("account"),recovery.getString("mode"))else null
        mutable.update {it.copy(remote=remote,book=null,mergeCounts=null,view="books",canRecoverMerge=false,message="已返回合并前书库；服务器已收到的合并内容保留")}
        if(remote!=null)persistConnection(remote,recovery.getString("workspace"))else preferences.edit().remove("origin").remove("account").remove("workspace").remove("authMode").remove("rootKey").commit()
        preferences.edit().remove("mergeRecovery").commit();reload()
    }
    fun togglePdfMode(book:Record)=perform("切换 PDF 版式") {
        val mode=if(book.text("readerMode")=="original")"reflow" else "original"
        val chapters=book.value.optJSONArray("chapters")
        require(mode!="reflow" || (chapters!=null && (0 until chapters.length()).any {i->
            val paragraphs=chapters.getJSONObject(i).optJSONArray("paragraphs")
            paragraphs!=null && (0 until paragraphs.length()).any {j->paragraphs.optString(j).isNotBlank()}
        })){"此 PDF 没有已提取的正文，请以重排模式重新导入；扫描文档可继续使用原版阅读"}
        repository.command("save",JSONObject().put("kind","books").put("id",book.id).put("expected",book.revision).put("patch",JSONObject().put("readerMode",mode)))
        reload();openBook(book.id);scheduleSync()
    }
    suspend fun awaitJob(repo:CoreRepository,result:JSONObject):JSONObject {
        val id=result.getString("job");activeNativeJob=id
        try {while(true) {
            val status=repo.command("job",JSONObject().put("id",id))
            when(status.getString("status")) {"completed"->return when(val result=status.opt("result")){is JSONObject->result;is JSONArray->JSONObject().put("items",result);else->JSONObject().put("value",result)};"failed","cancelled"->error(status.optString("error","任务失败"))}
            delay(250)
        }}catch(error:CancellationException) {withContext(NonCancellable){runCatching {repo.command("cancelJob",JSONObject().put("id",id))}};throw error}
        finally {activeNativeJob=null}
    }
    fun syncNow() {syncJob?.cancel();syncJob=perform("同步书库") {
        require(pendingRepository==null){"请先确认或取消整体合并"}
        val remote=mutable.value.remote?:error("请先连接服务器")
        val cap=remote.request("/api/v2/capabilities")
        mutable.update {it.copy(remoteStatus=cap)}
        try {awaitJob(repository,repository.command("syncOnce",remote.syncArguments(cap.getString("nodeId"))));reload();mutable.update {it.copy(message="本轮元数据和原文件同步完成")}}
        finally {runCatching {val info=repository.command("syncProgress",JSONObject().put("id",cap.getString("nodeId")).put("url",remote.origin).put("epoch",cap.get("epoch")));mutable.update {it.copy(syncInfo=info)}}}
    }}
    fun cancelSync(){syncJob?.cancel();mutable.value.remote?.let {WorkManager.getInstance(getApplication()).cancelUniqueWork("shufang-sync-${it.identity}")};mutable.update {it.copy(message="已取消当前同步；离线修改保留，可再次同步")}}
    fun scheduleSync() {
        if(pendingRepository!=null)return
        if(!mutable.value.autoSync)return
        val remote=mutable.value.remote?:return
        val workspace=preferences.getString("workspace",null)?:return
        val request=OneTimeWorkRequestBuilder<LibrarySyncWorker>().setInputData(workDataOf("origin" to remote.origin,"account" to remote.account,"mode" to remote.mode,"rootKey" to repository.key,"workspace" to workspace))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build()
        WorkManager.getInstance(getApplication()).enqueueUniqueWork("shufang-sync-${remote.identity}",ExistingWorkPolicy.REPLACE,request)
    }
    private fun registerPeriodicSync() {
        val remote=mutable.value.remote?:return;val workspace=preferences.getString("workspace",null)?:return
        val work=WorkManager.getInstance(getApplication())
        if(!mutable.value.autoSync){work.cancelUniqueWork("shufang-periodic-${remote.identity}");return}
        val request=PeriodicWorkRequestBuilder<LibrarySyncWorker>(15,TimeUnit.MINUTES).setInputData(workDataOf("origin" to remote.origin,"account" to remote.account,"mode" to remote.mode,"rootKey" to repository.key,"workspace" to workspace))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
        work.enqueueUniquePeriodicWork("shufang-periodic-${remote.identity}",ExistingPeriodicWorkPolicy.UPDATE,request)
    }
    fun autoSync(enabled:Boolean){preferences.edit().putBoolean("autoSync",enabled).apply();mutable.update {it.copy(autoSync=enabled)};registerPeriodicSync();if(enabled)scheduleSync()else mutable.value.remote?.let {WorkManager.getInstance(getApplication()).cancelUniqueWork("shufang-sync-${it.identity}")}}
    fun logout()=perform("退出服务器账号") {
        stopReading()?.join()
        syncJob?.cancel();mutable.value.remote?.let {WorkManager.getInstance(getApplication()).cancelUniqueWork("shufang-sync-${it.identity}");WorkManager.getInstance(getApplication()).cancelUniqueWork("shufang-periodic-${it.identity}");it.logout()};pendingRepository?.close();pendingRepository=null;repository.close();repository=CoreRepository(getApplication());repository.open()
        preferences.edit().remove("origin").remove("account").remove("workspace").remove("authMode").remove("rootKey").apply()
        mutable.update {it.copy(remote=null,book=null,view="books")};reload()
    }
    fun remoteAction(path:String,method:String="GET",body:JSONObject?=null)=perform("读取服务器状态") {
        val remote=mutable.value.remote?:error("请先连接服务器");val result=remote.request(path,method,body)
        mutable.update {it.copy(remoteStatus=if(path.startsWith("/api/auth/setup")||path.startsWith("/api/auth/profile"))result else it.remoteStatus,
            serverStartup=if(path=="/api/autostart/status")result else it.serverStartup,serverCodex=if(path.startsWith("/api/auth/codex/"))result else it.serverCodex,
            message=if(path=="/api/autostart/status")if(result.optBoolean("supported"))"服务器自启：${if(result.optBoolean("enabled"))"已启用"else "已关闭"}"else "服务器自启由外部服务管理，当前服务器不支持在应用中切换"
                else if(path.startsWith("/api/auth/codex/"))"服务器 Codex：${if(result.optBoolean("authenticated"))"已登录"else if(result.optBoolean("loginRunning"))"正在服务器上登录"else "未登录"}"else "服务器账户已更新")}
        if(path in listOf("/api/auth/setup","/api/auth/profile")) {
            val name=result.optJSONObject("user")?.optString("id")?.takeIf {it.isNotBlank()}?:remote.account
            val renamed=remote.renamed(name);mutable.update {it.copy(remote=renamed)}
            if(path=="/api/auth/setup")prepareConnection(renamed)else persistConnection(renamed,preferences.getString("workspace",null)?:error("书库身份不存在"))
        }
    }
    fun installLocalModel(uri:Uri)=perform("校验并安装离线模型") {localAi.install(uri);mutable.update {it.copy(localAiStatus=localAi.status())}}
    fun removeLocalModel()=perform("移除离线模型") {localAi.remove();mutable.update {it.copy(localAiStatus=localAi.status())}}
    fun askLocal(question:String)=perform("设备端模型正在回答") {aiJob=currentCoroutineContext()[Job];val current=mutable.value;val original=current.selection?.optString("text")?:current.book?.value?.optJSONArray("chapters")?.let {chapters->(0 until chapters.length()).map {chapters.getJSONObject(it)}.find {it.optString("id")==current.chapterId}?.optJSONArray("paragraphs")?.let {paragraphs->(0 until paragraphs.length()).joinToString("\n"){paragraphs.getString(it)}}}.orEmpty();mutable.update {it.copy(aiSource="设备端模型 · 本次请求不发送到服务器",aiTask="chat",aiQuestion=question,aiResult="")};val prompt="依据原文用中文回答，没依据请明确说明。\n原文：${original.take(1600)}\n问题：$question";localAi.answer(prompt).collect {answer->mutable.update {it.copy(aiResult=answer)}};mutable.update {it.copy(aiMessages=JSONArray().put(JSONObject().put("role","user").put("content",question)).put(JSONObject().put("role","assistant").put("content",it.aiResult)))}}
    fun configureAi(config:JSONObject,key:String)=perform("保存 AI 配置") {
        val old=repository.command("aiConfig");repository.command("saveAiConfig",JSONObject().put("expected",old.getLong("revision")).put("config",config).put("apiKey",key));reload()
    }
    fun lookupMetadata(query:String)=perform("检索书目元数据") {
        mutable.update {it.copy(metadataCandidates=emptyList())}
        val items=awaitJob(repository,repository.command("lookupMetadata",JSONObject().put("query",query))).getJSONArray("items")
        mutable.update {it.copy(metadataCandidates=(0 until items.length()).map {i->items.getJSONObject(i)})}
    }
    fun clearConversation(){mutable.update {it.copy(aiMessages=JSONArray(),aiResult="")}}
    fun openAi(){navigate("ai")}
    fun saveQa()=perform("保存文段问答") {
        val current=mutable.value;require(current.aiTask=="chat"&&current.aiResult.isNotBlank())
        val anchor=current.selection?:error("请先选择原文")
        val prior=anchor.optString("id").takeIf {it.isNotEmpty()}?.let {id->mutable.value.records["highlights"].orEmpty().find {it.id==id}}?.let {repository.get("highlights",it.id)}
        val patch=JSONObject((prior?.value?:anchor).toString()).apply {remove("kind")}
        val qa=patch.optJSONArray("aiQa")?:JSONArray()
        qa.put(JSONObject().put("q",current.aiQuestion).put("a",current.aiResult).put("ts",System.currentTimeMillis()))
        patch.put("aiQa",qa)
        val saved=repository.save("highlights",prior,patch);reload();mutable.update {it.copy(selection=saved.value,message="问答已保存到文段")};scheduleSync()
    }
    fun expandMind(map:Record,chapter:String)=perform("读取脑图章节") {
        val book=repository.get("books",map.text("bookId"))
        val fullMap=repository.get("mindMaps",map.id)
        mutable.update {it.copy(book=book,chapterId=chapter,selection=null,aiMindTarget=fullMap,view="ai")}
        ai("mindMap","依据当前章节生成最多六个主题，保留原脑图内容").join()
    }
    fun cancelAi(){aiJob?.cancel();mutable.update {it.copy(message="已取消 AI 等待；已发出的服务器请求可能仍在执行")}}
    fun ai(task:String,question:String,targetLanguage:String="中文")=perform("AI 正在处理") {
        aiJob=currentCoroutineContext()[Job]
        mutable.update {it.copy(aiSource="服务器 / Provider 模型 · 本次请求需要网络")}
        if(task!="mindMap")mutable.update {it.copy(aiMindTarget=null)}
        val anchor=mutable.value.selection;val book=mutable.value.book
        val normalizedTask=if(task=="mindMap")"mindmap"else task
        val context=anchor?.optString("text")?:book?.value?.optJSONArray("chapters")?.let {chapters->(0 until chapters.length()).map {chapters.getJSONObject(it)}.firstOrNull {it.optString("id")==mutable.value.chapterId}?.optJSONArray("paragraphs")?.let {paragraphs->(0 until paragraphs.length()).joinToString("\n"){paragraphs.optString(it)}}}.orEmpty()
        require(targetLanguage.isNotBlank()){ "请输入目标语言" }
        val request=JSONObject().put("task",normalizedTask).put("question",question).put("text",if(task=="digest")""else AiContext.prefix(context,100_000)).put("targetLang",targetLanguage)
        val messages=JSONArray()
        if(task=="chat") {
            val previous=mutable.value.aiMessages
            for(index in maxOf(0,previous.length()-18) until previous.length())messages.put(previous.getJSONObject(index))
            messages.put(JSONObject().put("role","user").put("content",AiContext.prefix(question,10_000)+"\n阅读资料：\n"+AiContext.prefix(context,40_000)))
            request.put("messages",messages)
        }
        book?.let {request.put("bookId",it.id)}
        val config=mutable.value.aiConfig.optJSONObject("value")?:error("请配置 AI")
        val result=if(config.optString("provider")=="codex") {
            val remote=mutable.value.remote?:error("Codex 需要连接服务器")
            val input=JSONObject().put("config",config).put("provider","codex").put("bookTitle",book?.text("title")?:"选文").put("chapterTitle",anchor?.optString("chapterTitle")?:"章节").put("text",request.optString("text")).put("targetLang",targetLanguage).put("context",question).put("question",question).put("messages",if(task=="chat")messages else JSONArray().put(JSONObject().put("role","user").put("content",question+"\n"+request.optString("text").take(50000))))
            if(task=="digest") {
                val chapters=book?.value?.optJSONArray("chapters")?:error("请先打开书籍")
                val summaries=mutableListOf<String>()
                for(index in 0 until chapters.length()) {
                    val chapter=chapters.getJSONObject(index);val paragraphs=chapter.optJSONArray("paragraphs")?:JSONArray()
                    val text=(0 until paragraphs.length()).joinToString("\n"){paragraphs.getString(it)}
                    for(part in AiContext.chunks(text,24_000)) {
                        currentCoroutineContext().ensureActive()
                        val prompt="概括章节 ${chapter.optString("title")} 的以下部分，仅依据正文：\n$part"
                        val rpc=remote.request("/api/trpc/ai.chat","POST",JSONObject().put("json",JSONObject(input.toString()).put("messages",JSONArray().put(JSONObject().put("role","user").put("content",prompt)))),180_000)
                        val data=rpc.getJSONObject("result").getJSONObject("data");val decoded=data.opt("json")?:data
                        summaries+=(if(decoded is JSONObject)decoded.optString("text").ifBlank {decoded.optString("content",decoded.toString())}else decoded.toString())
                        mutable.update {it.copy(busy="全书导读：第 ${index+1} / ${chapters.length()} 章")}
                    }
                }
                require(summaries.isNotEmpty()){ "该书没有可用于导读的正文" }
                var reductionRounds=0
                while(summaries.sumOf {it.length}>48_000) {
                    require(++reductionRounds<=8){"Provider 未能将导读摘要缩短，请更换模型后重试"}
                    val reduced=mutableListOf<String>()
                    for(part in AiContext.chunks(summaries.joinToString("\n"),48_000)) {
                        val prompt="将以下摘要合并为不超过 1500 字的结构化摘要，保留分歧和限制：\n"+part
                        val rpc=remote.request("/api/trpc/ai.chat","POST",JSONObject().put("json",JSONObject(input.toString()).put("messages",JSONArray().put(JSONObject().put("role","user").put("content",prompt)))),180_000)
                        val data=rpc.getJSONObject("result").getJSONObject("data");val decoded=data.opt("json")?:data
                        reduced+=(if(decoded is JSONObject)decoded.optString("text").ifBlank {decoded.optString("content",decoded.toString())}else decoded.toString())
                    };summaries.clear();summaries.addAll(reduced)
                }
                input.put("messages",JSONArray().put(JSONObject().put("role","user").put("content","根据以下全书摘要提炼章节脉络、主要论点和阅读建议。用户要求：$question\n"+summaries.joinToString("\n").take(48_000))))
            }
            val method=if(task=="chat"||task=="digest")"chat"else when(task){"translate"->"translate";"mindMap"->"mindmap";"studyCard"->"studyCard";"models"->"models";else->"testConnection"}
            val rpc=remote.request("/api/trpc/ai.$method","POST",JSONObject().put("json",input),180_000)
            val data=rpc.getJSONObject("result").getJSONObject("data");val decoded=data.opt("json")?:data
            when(decoded){is JSONObject->JSONObject(decoded.toString()).put("text",decoded.optString("text").ifBlank {decoded.optString("content").ifBlank {decoded.toString()}});is JSONArray->JSONObject().put("models",decoded).put("text",decoded.toString());else->JSONObject().put("text",decoded.toString())}
        }else awaitJob(repository,repository.command("ai",request))
        val models=result.optJSONArray("models")?.let {array->(0 until array.length()).map {i->val value=array.opt(i);if(value is JSONObject)value.optString("id")else value.toString()}}?:emptyList()
        if(task=="chat")messages.put(JSONObject().put("role","assistant").put("content",AiContext.prefix(result.optString("text"),50_000)))
        mutable.update {it.copy(aiResult=result.optString("text",result.toString(2)),aiTask=normalizedTask,aiQuestion=question,aiLanguage=targetLanguage,aiMessages=if(task=="chat")messages else it.aiMessages,aiModels=if(task=="models")models else it.aiModels)}
    }
    fun saveAi()=perform("保存 AI 内容") {
        val current=mutable.value
        val anchor=current.selection?:current.book?.let {JSONObject().put("bookId",it.id).put("chapterId",current.chapterId)}
        if(current.aiTask in listOf("translate","mindmap","studyCard"))repository.command("saveAiResult",JSONObject().put("task",current.aiTask).put("text",current.aiResult).put("anchor",anchor).put("bookId",current.book?.id).put("targetLang",current.aiLanguage).apply {if(current.aiTask=="mindmap")current.aiMindTarget?.let {put("mindMapId",it.id);put("expected",it.revision)}})
        else repository.save("notes",null,JSONObject().put("title","AI 阅读笔记").put("content",current.aiResult))
        reload();mutable.update {it.copy(aiMindTarget=null,message="AI 内容已保存")};scheduleSync()
    }
    override fun onCleared() {
        runCatching {connectivity.unregisterNetworkCallback(networkCallback)};routeProbe?.cancel()
        val wasReading=readingBeat!=null
        creditReading(false);readingBeat?.cancel();readingBeat=null;readingClock=null;aiJob?.cancel();syncJob?.cancel()
        val repo=repository;val pending=pendingRepository;val book=mutable.value.book
        val position=JSONObject().put("chapterId",readingPosition.chapter).put("ratio",readingPosition.ratio)
        val args=book?.takeIf {wasReading}?.let {JSONObject().put("id",it.id).put("session",readingSession).put("progress",position).put("activeSeconds",readingPosition.activeSeconds).put("summary",true)}
        CoroutineScope(Dispatchers.IO).launch {try {if(args!=null)runCatching {repo.command("checkpoint",args)}}finally {runCatching {repo.close()};pending?.let {runCatching {it.close()}}}}
        super.onCleared()
    }
}

class LibrarySyncWorker(context:android.content.Context,parameters:WorkerParameters):CoroutineWorker(context,parameters) {
    override suspend fun doWork():Result {
        val origin=inputData.getString("origin")?:return Result.failure();val account=inputData.getString("account")?:return Result.failure();val workspace=inputData.getString("workspace")?:return Result.failure()
        val client=RemoteClient(SecretVault(applicationContext),origin,account,inputData.getString("mode")?:"account")
        val repository=CoreRepository(applicationContext,inputData.getString("rootKey")?:"remote-${client.identity}")
        return try {
            repository.open(workspace);val cap=client.request("/api/v2/capabilities")
            val started=repository.command("syncOnce",client.syncArguments(cap.getString("nodeId")))
            val id=started.getString("job")
            while(true) {
                val job=repository.command("job",JSONObject().put("id",id));val status=job.getString("status")
                if(status=="completed")return Result.success()
                if(status in listOf("failed","cancelled"))return if(runAttemptCount<5)Result.retry()else Result.failure()
                delay(300)
            }
            @Suppress("UNREACHABLE_CODE") Result.failure()
        }catch(error:Exception) {if(error is CancellationException)throw error;if(runAttemptCount<5)Result.retry()else Result.failure()}
        finally {withContext(NonCancellable){repository.close()}}
    }
}
