import json
import os

# ================= 配置 =================
START_INDEX = 1   # 起始文件编号
END_INDEX = 16    # 结束文件编号
OUTPUT_FILE = "raw_data_for_notebooklm.txt" # 输出文件名
# =======================================

def main():
    # 打开输出文件（使用 'w' 模式，会覆盖旧文件）
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as out_f:
        
        print(f"🚀 开始合并 {START_INDEX}.json 到 {END_INDEX}.json ...")
        
        for i in range(START_INDEX, END_INDEX + 1):
            filename = f"data/问答题/{i}.json"
            
            # 1. 检查文件是否存在
            if not os.path.exists(filename):
                print(f"⚠️ 跳过: {filename} (文件不存在)")
                continue
            
            try:
                # 2. 读取 JSON
                # encoding='utf-8-sig' 可以自动处理 Windows 可能带的 BOM 头
                with open(filename, 'r', encoding='utf-8-sig') as in_f:
                    data = json.load(in_f)
                
                # 写入章节标记（方便 NotebookLM 区分来源）
                out_f.write(f"\n\n{'='*20} 来自文件: {filename} {'='*20}\n\n")
                
                count = 0
                for item in data:
                    # 3. 原样提取内容
                    q = item.get('q', '').strip()
                    a = item.get('a', '').strip()
                    tag = item.get('tag', '') # 标签可能是空的
                    
                    if q:
                        # 4. 写入 TXT 格式
                        out_f.write(f"题目: {q}\n")
                        out_f.write(f"答案: {a}\n")
                        if tag:
                            out_f.write(f"标签: {tag}\n")
                        out_f.write("-" * 40 + "\n") # 分隔线
                        count += 1
                
                print(f"✅ {filename}: 已写入 {count} 条数据")

            except json.JSONDecodeError:
                print(f"❌ 错误: {filename} JSON 格式不对")
            except Exception as e:
                print(f"❌ 错误: {filename} - {str(e)}")

    print(f"\n🎉 全部完成！输出文件在这里: {OUTPUT_FILE}")

if __name__ == "__main__":
    main()