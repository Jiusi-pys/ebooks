package org.shufang.android

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.json.JSONObject
import java.io.File

/** Read-only real HTTPS checks, enabled explicitly with -e realServer https://us.jiusi.org. */
class RealServerTest {
    @Test fun explicitAcceptanceCredentialsUseRealAndroidTls()=runBlocking {
        val path=InstrumentationRegistry.getArguments().getString("realAuthFile")
        assumeTrue("Explicit isolated acceptance credentials not selected",path!=null)
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName.endsWith(".acceptance"))
        val file=File(context.filesDir,path!!).canonicalFile
        check(file.parentFile==context.filesDir.canonicalFile)
        val config=JSONObject(file.readText())
        var client=RemoteClient(SecretVault(context),RemoteAddress.normalize(config.getString("origin")),config.getString("user"))
        try {
            val login=client.login(config.getString("user"),config.getString("password"))
            val user=login.optJSONObject("user")?.optString("id").orEmpty()
            if(user.isNotBlank())client=client.renamed(user)
            assertTrue(client.request("/api/auth/session").getBoolean("authenticated"))
            val capabilities=client.request("/api/v2/capabilities")
            assertTrue(capabilities.getString("workspaceId").isNotBlank())
            assertTrue(capabilities.getString("nodeId").isNotBlank())
            var preflight=false
            if(capabilities.optInt("conditionalPush",0)==1){
                assertEquals(0,client.request("/api/v2/sync/preflight","POST",JSONObject().put("operations",org.json.JSONArray())).getJSONArray("entries").length())
                preflight=true
            }
            File(context.getExternalFilesDir(null),"real-server-capability.json").writeText(JSONObject().put("conditionalPush",capabilities.optInt("conditionalPush",0)).put("authenticated",true).put("readOnlyPreflightPassed",preflight).put("productionBusinessWrites",false).toString())
        }finally {client.logout();file.delete()}
    }
    private fun origin():String {
        val value=InstrumentationRegistry.getArguments().getString("realServer")
        assumeTrue("Real HTTPS server not selected",!value.isNullOrBlank())
        return RemoteAddress.normalize(value!!)
    }
    @Test fun publicSessionUsesAndroidTlsAndReportsConfiguredAccount()=runBlocking {
        val server=origin()
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val client=RemoteClient(SecretVault(context),server,"android-public-probe")
        val session=client.request("/api/auth/session")
        assertTrue("Server account authentication is unavailable",session.getBoolean("configured"))
        assertFalse(session.getBoolean("authenticated"))
    }
    @Test fun existingAccountSessionCanReadSyncCapabilities()=runBlocking {
        val server=origin()
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val prefs=context.getSharedPreferences("android-ui",android.content.Context.MODE_PRIVATE)
        assumeTrue("User must sign in to us in the app for authenticated validation",prefs.getString("origin",null)==server)
        val account=prefs.getString("account",null)
        assumeTrue("No persisted account session",!account.isNullOrBlank())
        val client=RemoteClient(SecretVault(context),server,account!!,prefs.getString("authMode","account")!!)
        if(client.mode=="account")assertTrue(client.request("/api/auth/session").getBoolean("authenticated"))
        val capabilities=client.request("/api/v2/capabilities")
        assertTrue(capabilities.getString("workspaceId").isNotBlank())
        assertTrue(capabilities.getString("nodeId").isNotBlank())
    }
}
