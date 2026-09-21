package com.zbgamelt.forum;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AbsListView;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** 首页：帖子列表（分页拉 /api/threads）。 */
public class MainActivity extends Activity {
    private final List<JSONObject> items = new ArrayList<JSONObject>();
    private BaseAdapter adapter;
    private TextView foot;
    private int page = 1;
    private int pages = 1;
    private boolean loading = false;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Ui.BG);
        root.addView(header());

        ListView list = new ListView(this);
        list.setBackgroundColor(Ui.BG);
        list.setDivider(null);
        list.setDividerHeight(0);
        list.setCacheColorHint(0);
        list.setSelector(new android.graphics.drawable.ColorDrawable(0));
        adapter = new Adapter();
        list.setAdapter(adapter);
        root.addView(list, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        foot = Ui.tv(this, "正在加载…", 13, Ui.MUTED, false);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, Ui.dp(this, 14), 0, Ui.dp(this, 20));
        foot.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (!loading) { page = 1; load(1); }
            }
        });
        root.addView(foot);

        list.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override public void onItemClick(AdapterView<?> parent, View v, int pos, long id) {
                if (pos < 0 || pos >= items.size()) return;
                JSONObject o = items.get(pos);
                Intent i = new Intent(MainActivity.this, ThreadActivity.class);
                i.putExtra("n", Json.i(o, "n"));
                i.putExtra("t", Json.s(o, "t"));
                startActivity(i);
            }
        });
        list.setOnScrollListener(new AbsListView.OnScrollListener() {
            @Override public void onScrollStateChanged(AbsListView v, int s) {}
            @Override public void onScroll(AbsListView v, int first, int visible, int total) {
                if (total > 0 && first + visible >= total - 2) loadMore();
            }
        });

        setContentView(root);
        load(1);
    }

    private View header() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(Ui.dp(this, 16), Ui.dp(this, 18), Ui.dp(this, 14), Ui.dp(this, 10));

        LinearLayout col = Ui.column(this);
        TextView title = Ui.tv(this, "主播模拟器mod", 19, Ui.TEXT, true);
        TextView sub = Ui.tv(this, "看帖 · 回帖", 12, Ui.MUTED, false);
        col.addView(title);
        col.addView(sub);
        bar.addView(col, Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        bar.addView(Ui.ghost(this, "我的", new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, MeActivity.class));
            }
        }));
        return bar;
    }

    private void load(final int p) {
        if (loading) return;
        loading = true;
        if (p <= 1) {
            items.clear();
            adapter.notifyDataSetChanged();
            foot.setText("正在加载…");
        }
        Api.get("/api/threads?page=" + p + "&per=20", null, new Api.Cb() {
            @Override public void done(JSONObject ok, String err) {
                loading = false;
                if (err != null) {
                    foot.setText(err + "（点这里重试）");
                    return;
                }
                page = Json.i(ok, "page");
                pages = Json.i(ok, "pages");
                if (pages < 1) pages = 1;
                JSONArray arr = ok.optJSONArray("threads");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject o = arr.optJSONObject(i);
                        if (o != null) items.add(o);
                    }
                }
                adapter.notifyDataSetChanged();
                if (items.isEmpty()) {
                    foot.setText("还没有帖子");
                } else if (page < pages) {
                    foot.setText("上滑加载更多");
                } else {
                    foot.setText("—— 到底了 ——");
                }
            }
        });
    }

    private void loadMore() {
        if (!loading && page < pages) load(page + 1);
    }

    @Override protected void onResume() {
        super.onResume();
        // 从「我的」退出登录回来时，列表本身不用动；这里留个钩子给以后刷新用
    }

    private final class Adapter extends BaseAdapter {
        @Override public int getCount() { return items.size(); }
        @Override public Object getItem(int p) { return items.get(p); }
        @Override public long getItemId(int p) { return p; }

        @Override public View getView(int pos, View reuse, ViewGroup parent) {
            JSONObject o = items.get(pos);

            LinearLayout wrap = Ui.column(MainActivity.this);
            wrap.setPadding(Ui.dp(MainActivity.this, 14), Ui.dp(MainActivity.this, 4),
                    Ui.dp(MainActivity.this, 14), Ui.dp(MainActivity.this, 4));

            LinearLayout card = Ui.card(MainActivity.this);

            String emoji = Json.s(o, "emoji");
            String titleText = (emoji.length() > 0 ? emoji + " " : "") + Json.s(o, "t");
            TextView title = Ui.tv(MainActivity.this, titleText, 16, Ui.TEXT, true);
            title.setMaxLines(2);
            card.addView(title);

            StringBuilder meta = new StringBuilder();
            String by = Json.s(o, "by");
            if (by.length() > 0) meta.append(by).append(" · ");
            String cat = Json.s(o, "cat");
            if (cat.length() > 0) meta.append(cat).append(" · ");
            String ago = Ui.ago(Json.l(o, "at"));
            if (ago.length() > 0) meta.append(ago).append(" · ");
            meta.append(Json.i(o, "cn")).append(" 回复");
            TextView m = Ui.tv(MainActivity.this, meta.toString(), 12, Ui.MUTED, false);
            m.setPadding(0, Ui.dp(MainActivity.this, 6), 0, 0);
            card.addView(m);

            String ex = Json.s(o, "ex");
            if (ex.length() > 0) {
                TextView e = Ui.tv(MainActivity.this, ex, 13, Ui.MUTED, false);
                e.setMaxLines(2);
                e.setPadding(0, Ui.dp(MainActivity.this, 8), 0, 0);
                card.addView(e);
            }

            wrap.addView(card, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT));
            wrap.setLayoutParams(new AbsListView.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            return wrap;
        }
    }
}
